import { statSync } from "node:fs"
import { Plugin } from "@opencode/plugin"
import type { Tool } from "@opencode/schema/tool"
import ignore from "ignore"
import { isPathValid } from "ignore"
import { isAbsolute, join, relative, resolve } from "path"

/**
 * Load ignore patterns from project root.
 * Uses .ignore file.
 */
async function loadIgnore(projectRoot: string): Promise<ReturnType<typeof ignore> | null> {
  const ignorePath = join(projectRoot, ".ignore")
  const file = Bun.file(ignorePath)
  if (await file.exists()) {
    const ignoreLib = ignore()
    ignoreLib.add(await file.text())
    return ignoreLib
  }

  return null
}

/**
 * Normalize path to the format required by the ignore library.
 * Relative to project root, no "./" prefix, forward slashes, trailing "/" for directories.
 */
function normalizePath(targetPath: string, projectRoot: string, isDirectory: boolean): string | undefined {
  const absolutePath = isAbsolute(targetPath) ? targetPath : join(projectRoot, targetPath)
  const relativePath = relative(projectRoot, absolutePath)
  const resolvedPath = relativePath === "" ? "." : relativePath
  const normalizedPath = resolvedPath.replace(/\\/g, "/")
  const withoutPrefixPath = normalizedPath.startsWith("./") ? normalizedPath.slice(2) : normalizedPath
  const withSlashPath = isDirectory && withoutPrefixPath !== "." && !withoutPrefixPath.endsWith("/")
    ? withoutPrefixPath + "/"
    : withoutPrefixPath

  if (!isPathValid(withSlashPath)) return undefined
  return withSlashPath
}

type IgnoreLib = ReturnType<typeof ignore>
type PathKind = "file" | "directory" | "missing"

interface PathInfo {
  path: string
  kind: PathKind
}

function pathKind(targetPath: string, projectRoot: string): PathKind {
  if (targetPath === "." || targetPath === "") return "directory"
  const absolutePath = isAbsolute(targetPath) ? targetPath : join(projectRoot, targetPath)
  const info = statSync(absolutePath, { throwIfNoEntry: false })
  if (!info) return "missing"
  if (info.isDirectory()) return "directory"
  return "file"
}

function formsFor(kind: PathKind): boolean[] {
  if (kind === "directory") return [true]
  if (kind === "file") return [false]
  return [false, true]
}

function isIgnored(ignoreLib: IgnoreLib, targetPath: string, projectRoot: string, isDirectory: boolean): boolean {
  const normalized = normalizePath(targetPath, projectRoot, isDirectory)
  if (!normalized || normalized === ".") return false
  return ignoreLib.ignores(normalized)
}

function matchesIgnore(ignoreLib: IgnoreLib, target: PathInfo, projectRoot: string): boolean {
  if (target.path === "." || target.path === "") return false
  return formsFor(target.kind).some((isDirectory) => isIgnored(ignoreLib, target.path, projectRoot, isDirectory))
}

function inputRecord(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input)) return input as Record<string, unknown>
  return {}
}

function stringField(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key]
  return typeof value === "string" ? value : undefined
}

function numberField(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key]
  return typeof value === "number" ? value : undefined
}

const PATCH_PATH = /^\*\*\* (?:Add File|Update File|Delete File|Move to):\s*(.+?)\s*$/gm

function patchPaths(patchText: string): string[] {
  return [...patchText.matchAll(PATCH_PATH)].flatMap((match) => match[1] ? [match[1]] : [])
}

function targetsFor(tool: string, input: Record<string, unknown>, projectRoot: string): PathInfo[] {
  if (tool === "read" || tool === "write" || tool === "edit") {
    const targetPath = stringField(input, "path")
    if (targetPath === undefined) return []
    if (targetPath === "") return [{ path: ".", kind: "directory" }]
    if (tool === "read") return [{ path: targetPath, kind: pathKind(targetPath, projectRoot) }]
    return [{ path: targetPath, kind: "file" }]
  }

  if (tool === "glob") {
    const targetPath = stringField(input, "path") || "."
    return [{ path: targetPath === "" ? "." : targetPath, kind: "directory" }]
  }

  if (tool === "grep") {
    const targetPath = stringField(input, "path") || "."
    const path = targetPath === "" ? "." : targetPath
    return [{ path, kind: pathKind(path, projectRoot) }]
  }

  if (tool === "patch") {
    const patchText = stringField(input, "patchText")
    if (!patchText) return []
    return patchPaths(patchText).map((path) => ({ path, kind: "file" as const }))
  }

  return []
}

const denied = (targetPath: string) =>
  `Access denied: ${targetPath} blocked by ignore file. Do NOT try to read this. Access restricted.`

interface GlobEntry {
  path: string
  type?: string
}

interface GrepMatch {
  entry: { path: string; type?: string }
  line: number
  text: string
}

interface ListEntry {
  path: string
  type?: string
}

interface ListPage {
  type: "list-page"
  entries: ListEntry[]
  truncated: boolean
  next?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function globEntry(value: unknown): GlobEntry | undefined {
  if (!isRecord(value) || typeof value.path !== "string") return undefined
  return { path: value.path, type: typeof value.type === "string" ? value.type : undefined }
}

function grepMatch(value: unknown): GrepMatch | undefined {
  if (!isRecord(value) || !isRecord(value.entry) || typeof value.entry.path !== "string") return undefined
  if (typeof value.line !== "number" || typeof value.text !== "string") return undefined
  return {
    entry: { path: value.entry.path, type: typeof value.entry.type === "string" ? value.entry.type : undefined },
    line: value.line,
    text: value.text,
  }
}

function listPage(value: unknown): ListPage | undefined {
  if (!isRecord(value) || value.type !== "list-page" || !Array.isArray(value.entries)) return undefined
  const entries = value.entries.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.path !== "string") return []
    return [{ path: entry.path, type: typeof entry.type === "string" ? entry.type : undefined }]
  })
  return {
    type: "list-page",
    entries,
    truncated: value.truncated === true,
    next: typeof value.next === "number" ? value.next : undefined,
  }
}

function modelText(entries: string[], empty: string, truncated: boolean): string {
  const lines = entries.length === 0 ? [empty] : entries
  if (!truncated) return lines.join("\n")
  return [
    ...lines,
    "",
    `(Results are truncated: showing first ${entries.length} results. Consider using a more specific path or pattern.)`,
  ].join("\n")
}

function globModelContent(entries: GlobEntry[], projectRoot: string, truncated: boolean): string {
  return modelText(entries.map((entry) => resolve(projectRoot, entry.path)), "No files found", truncated)
}

function grepModelContent(matches: GrepMatch[], projectRoot: string, truncated: boolean): string {
  const header = matches.length === 0 ? ["No matches found"] : [`Found ${matches.length} matches`]
  const lines = matches.reduce((collected, match, index) => {
    const display = resolve(projectRoot, match.entry.path)
    const earlier = matches[index - 1]
    const previous = earlier ? resolve(projectRoot, earlier.entry.path) : ""
    const lead = display === previous ? [] : [...(previous ? [""] : []), `${display}:`]
    return [...collected, ...lead, `  Line ${match.line}: ${match.text}`]
  }, header)
  if (!truncated) return lines.join("\n")
  return [
    ...lines,
    "",
    `(Results are truncated: showing first ${matches.length} results. Consider using a more specific path or pattern.)`,
  ].join("\n")
}

function listModelContent(directory: string, offset: number | undefined, page: ListPage): string {
  const start = offset || 1
  const header = page.entries.length === 0
    ? `Read directory ${directory}, 0 entries`
    : `Read directory ${directory}, entries ${start}-${start + page.entries.length - 1}`
  const footer = page.truncated && page.next !== undefined
    ? [`[Output truncated. Continue reading with offset: ${page.next}]`]
    : []
  return [header, ...page.entries.map((entry) => entry.path), ...footer].join("\n")
}

function keptMetadata(metadata: Tool.Metadata | undefined, key: string, count: number): Tool.Metadata {
  return { ...(metadata ?? {}), [key]: count }
}

function filteredResult(result: Tool.Result, output: Tool.Result["output"], content: string, metadata: Tool.Metadata): Tool.Result {
  return { ...result, output, content, metadata }
}

function entryTarget(directory: string, entry: ListEntry): PathInfo {
  const isDirectory = entry.type === "directory" || entry.path.endsWith("/") || entry.path.endsWith("\\")
  const name = entry.path.replace(/[\\/]+$/, "")
  const path = directory === "." || directory === "" ? name : `${directory.replace(/\\/g, "/")}/${name}`
  return { path, kind: isDirectory ? "directory" : "file" }
}

function filterGlob(result: Tool.Result, ignoreLib: IgnoreLib, projectRoot: string): Tool.Result {
  if (!Array.isArray(result.output)) return result
  const entries = result.output.flatMap((entry) => {
    const parsed = globEntry(entry)
    if (!parsed) return []
    if (matchesIgnore(ignoreLib, { path: parsed.path, kind: "file" }, projectRoot)) return []
    return [parsed]
  })
  const truncated = result.metadata?.truncated === true
  return filteredResult(result, entries, globModelContent(entries, projectRoot, truncated), keptMetadata(result.metadata, "count", entries.length))
}

function filterGrep(result: Tool.Result, ignoreLib: IgnoreLib, projectRoot: string): Tool.Result {
  if (!Array.isArray(result.output)) return result
  const matches = result.output.flatMap((match) => {
    const parsed = grepMatch(match)
    if (!parsed) return [match]
    if (matchesIgnore(ignoreLib, { path: parsed.entry.path, kind: "file" }, projectRoot)) return []
    return [match]
  })
  const parsedMatches = matches.flatMap((match) => {
    const parsed = grepMatch(match)
    return parsed ? [parsed] : []
  })
  const truncated = result.metadata?.truncated === true
  return filteredResult(
    result,
    matches,
    grepModelContent(parsedMatches, projectRoot, truncated),
    keptMetadata(result.metadata, "matches", matches.length),
  )
}

function filterRead(result: Tool.Result, input: unknown, ignoreLib: IgnoreLib, projectRoot: string): Tool.Result {
  const page = listPage(result.output)
  if (!page) return result
  const directory = stringField(inputRecord(input), "path") || "."
  const entries = page.entries.filter((entry) => !matchesIgnore(ignoreLib, entryTarget(directory, entry), projectRoot))
  const filtered = { ...page, entries }
  return filteredResult(
    result,
    filtered,
    listModelContent(directory, numberField(inputRecord(input), "offset"), filtered),
    result.metadata ?? {},
  )
}

/**
 * OpenCode v2 plugin that blocks native file tools using .ignore patterns.
 *
 * read, write, and edit are denied before execution. glob and grep may search
 * an allowed root, then ignored paths and their previews are removed from the result.
 * patch is denied when any hunk path is ignored.
 */
const OpenCodeIgnore = Plugin.define({
  id: "opencode-ignore",
  async setup(ctx) {
    const projectRoot = ctx.location.directory

    await ctx.tool.hook("execute.before", async (event) => {
      const ignoreLib = await loadIgnore(projectRoot)
      if (!ignoreLib) return

      const blocked = targetsFor(event.tool, inputRecord(event.input), projectRoot)
        .find((target) => matchesIgnore(ignoreLib, target, projectRoot))
      if (!blocked) return

      throw new Error(denied(blocked.path))
    })

    await ctx.tool.hook("execute.after", async (event) => {
      if (event.status !== "completed") return
      const ignoreLib = await loadIgnore(projectRoot)
      if (!ignoreLib) return

      if (event.tool === "glob") {
        event.result = filterGlob(event.result, ignoreLib, projectRoot)
        return
      }
      if (event.tool === "grep") {
        event.result = filterGrep(event.result, ignoreLib, projectRoot)
        return
      }
      if (event.tool === "read") {
        event.result = filterRead(event.result, event.input, ignoreLib, projectRoot)
      }
    })
  },
})

export default OpenCodeIgnore
