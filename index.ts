import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs"
import { Plugin } from "@opencode/plugin"
import type { Tool } from "@opencode/schema/tool"
import ignore from "ignore"
import { basename, dirname, isAbsolute, join, relative, resolve } from "path"

/**
 * Load ignore patterns from project root.
 * Uses .ignore file.
 */
async function loadIgnore(projectRoot: string): Promise<ReturnType<typeof ignore> | null> {
  const ignorePath = join(projectRoot, ".ignore")
  const file = Bun.file(ignorePath)
  if (await file.exists()) {
    const ignoreLib = ignore()
    ignoreLib.add(foldText(await file.text()))
    return ignoreLib
  }

  return null
}

function foldText(value: string): string {
  return value.normalize("NFC")
    .replace(/[\u00A0\u202F]/g, " ")
    .replace(/[\u2018\u2019]/g, "'")
}

/**
 * Normalize path to the format required by the ignore library.
 * Relative to project root, no "./" prefix, forward slashes, trailing "/" for directories.
 */
function normalizePath(targetPath: string, projectRoot: string, isDirectory: boolean): string | undefined {
  const foldedPath = foldText(targetPath)
  const absolutePath = isAbsolute(foldedPath) ? foldedPath : join(projectRoot, foldedPath)
  const relativePath = relative(projectRoot, absolutePath)
  const resolvedPath = relativePath === "" ? "." : relativePath
  const normalizedPath = resolvedPath.replace(/\\/g, "/")
  const withoutPrefixPath = normalizedPath.startsWith("./") ? normalizedPath.slice(2) : normalizedPath
  const withSlashPath = isDirectory && withoutPrefixPath !== "." && !withoutPrefixPath.endsWith("/")
    ? withoutPrefixPath + "/"
    : withoutPrefixPath

  if (withSlashPath !== "." && !ignore.isPathValid(withSlashPath)) return undefined
  return withSlashPath
}

const POLICY_FILE = ".ignore"

function isPolicyFile(targetPath: string, projectRoot: string): boolean {
  const normalized = normalizePath(targetPath, projectRoot, false)
  if (!normalized) return false
  const name = process.platform === "win32" || process.platform === "darwin" ? normalized.toLowerCase() : normalized
  return name === POLICY_FILE
}

type IgnoreLib = ReturnType<typeof ignore>
type PathKind = "file" | "directory" | "missing" | "invalid"

interface PathInfo {
  path: string
  kind: PathKind
}

function pathKind(targetPath: string, projectRoot: string): PathKind {
  if (targetPath === "." || targetPath === "") return "directory"
  const absolutePath = isAbsolute(targetPath) ? targetPath : join(projectRoot, targetPath)
  const info = (() => {
    try {
      return statSync(absolutePath, { throwIfNoEntry: false })
    } catch {
      return null
    }
  })()
  if (info === null) return "invalid"
  if (!info) return "missing"
  if (info.isDirectory()) return "directory"
  return "file"
}

function formsFor(kind: PathKind): boolean[] {
  if (kind === "directory") return [true]
  if (kind === "file") return [false]
  if (kind === "invalid") return [false, true]
  return [false, true]
}

function leavesProject(targetPath: string, kind: PathKind, projectRoot: string): boolean {
  if (targetPath === "." || targetPath === "") return false
  return formsFor(kind).every((isDirectory) => normalizePath(targetPath, projectRoot, isDirectory) === undefined)
}

function ignoredByPattern(ignoreLib: IgnoreLib, targetPath: string, kind: PathKind, projectRoot: string): boolean {
  return formsFor(kind).some((isDirectory) => {
    const normalized = normalizePath(targetPath, projectRoot, isDirectory)
    if (!normalized || normalized === ".") return false
    return ignoreLib.ignores(normalized)
  })
}

const MAX_LINK_HOPS = 40

/**
 * Real path of a target that may not exist yet. A missing path is resolved
 * through its nearest existing parent, and a dangling link through its target,
 * so a new file under a linked folder is checked where it will be written.
 */
function realPathOf(absolute: string, hops = 0): string | null {
  if (hops > MAX_LINK_HOPS) return null
  const info = (() => {
    try {
      return statSync(absolute, { throwIfNoEntry: false })
    } catch {
      return null
    }
  })()
  if (info === null) return null
  if (info) {
    try {
      return realpathSync(absolute)
    } catch {
      return null
    }
  }
  const link = (() => {
    try {
      const entry = lstatSync(absolute, { throwIfNoEntry: false })
      return entry?.isSymbolicLink() ? readlinkSync(absolute) : undefined
    } catch {
      return null
    }
  })()
  if (link === null) return null
  if (link !== undefined) return realPathOf(resolve(dirname(absolute), link), hops + 1)
  const parent = dirname(absolute)
  if (parent === absolute) return null
  const realParent = realPathOf(parent, hops)
  return realParent && join(realParent, basename(absolute))
}

function canonicalTarget(targetPath: string, projectRoot: string): string | undefined | null {
  if (targetPath === "." || targetPath === "") return undefined
  const absolute = isAbsolute(targetPath) ? targetPath : join(projectRoot, targetPath)
  const realTarget = realPathOf(absolute)
  const realRoot = (() => {
    try {
      return realpathSync(projectRoot)
    } catch {
      return null
    }
  })()
  if (!realTarget || !realRoot) return null
  const relativePath = relative(realRoot, realTarget).replace(/\\/g, "/")
  return relativePath === "" ? "." : relativePath
}

function matchesIgnore(ignoreLib: IgnoreLib, target: PathInfo, projectRoot: string): boolean {
  if (target.path === "." || target.path === "") return false
  if (target.kind === "invalid") return true
  if (isPolicyFile(target.path, projectRoot)) return true
  if (leavesProject(target.path, target.kind, projectRoot)) return true
  if (ignoredByPattern(ignoreLib, target.path, target.kind, projectRoot)) return true

  const canonical = canonicalTarget(target.path, projectRoot)
  if (canonical === null) return true
  const requested = normalizePath(target.path, projectRoot, false)
  if (!canonical || canonical === "." || canonical === requested) return false
  if (isPolicyFile(canonical, projectRoot)) return true
  if (leavesProject(canonical, target.kind, projectRoot)) return true
  return ignoredByPattern(ignoreLib, canonical, target.kind, projectRoot)
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

function patchPaths(patchText: string): string[] {
  const stripped = patchText.trim().match(/^(?:cat\s+)?<<(['"]?)(\w+)\1\s*\n([\s\S]*?)\n\2\s*$/)?.[3] ?? patchText.trim()
  const lines = stripped.split("\n").map((line) => line.endsWith("\r") ? line.slice(0, -1) : line)
  const paths: string[] = []
  const isHeader = (line: string) => line.startsWith("*** Add File: ") || line.startsWith("*** Delete File: ") || line.startsWith("*** Update File: ")
  const collect = (line: string) => {
    const header = line.trim()
    const prefix = ["*** Add File: ", "*** Delete File: ", "*** Update File: "].find((item) => header.startsWith(item))
    if (prefix) paths.push(header.slice(prefix.length).trim())
  }
  const end = lines.at(-1)?.trim() === "*** End Patch" ? lines.length - 1 : lines.length
  let index = lines[0]?.trim() === "*** Begin Patch" ? 1 : 0
  while (index < end) {
    const line = lines[index] ?? ""
    const header = line.trim()
    if (header.startsWith("*** Add File: ")) {
      collect(line)
      index++
      while (index < end && !isHeader((lines[index] ?? "").trim())) index++
      continue
    }
    if (header.startsWith("*** Delete File: ")) {
      collect(line)
      index++
      continue
    }
    if (header.startsWith("*** Update File: ")) {
      collect(line)
      index++
      while (lines[index]?.trimEnd() === "*** End of File") index++
      const move = lines[index]?.trimEnd()
      if (move === "*** Move to:" || move?.startsWith("*** Move to: ")) {
        const destination = move.slice("*** Move to: ".length).trim()
        if (destination) paths.push(destination)
        index++
      }
      while (index < end && !isHeader((lines[index] ?? "").trimEnd())) index++
      continue
    }
    index++
  }
  return paths
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

function ignoredNote(removed: number): string {
  if (removed <= 0) return ""
  if (removed === 1) return " 1 ignored hit was removed."
  return ` ${removed} ignored hits were removed.`
}

function modelText(entries: string[], empty: string, truncated: boolean, window: number, removed: number): string {
  const lines = entries.length === 0 ? [empty] : entries
  if (!truncated) return lines.join("\n")
  return [
    ...lines,
    "",
    `(Results are truncated: showing first ${window} results.${ignoredNote(removed)} Consider using a more specific path or pattern.)`,
  ].join("\n")
}

function globModelContent(entries: GlobEntry[], projectRoot: string, truncated: boolean, window: number, removed: number): string {
  return modelText(entries.map((entry) => resolve(projectRoot, entry.path)), "No files found", truncated, window, removed)
}

function grepModelContent(matches: GrepMatch[], projectRoot: string, truncated: boolean, window: number, removed: number): string {
  const header = matches.length === 0 ? ["No matches found"] : [`Found ${matches.length} matches`]
  const lines = matches.reduce((collected, match, index) => {
    const display = resolve(projectRoot, match.entry.path)
    const earlier = matches[index - 1]
    const previous = earlier ? resolve(projectRoot, earlier.entry.path) : ""
    const lead = display === previous ? [] : [...(previous ? [""] : []), `${display}:`]
    return [...collected, ...lead, ` Line ${match.line}: ${match.text}`]
  }, header)
  if (!truncated) return lines.join("\n")
  return [
    ...lines,
    "",
    `(Results are truncated: showing first ${window} results.${ignoredNote(removed)} Consider using a more specific path or pattern.)`,
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

function entryTarget(directory: string, entry: ListEntry, projectRoot: string): PathInfo {
  const name = entry.path.replace(/[\\/]+$/, "")
  const path = directory === "." || directory === "" ? name : `${directory.replace(/\\/g, "/")}/${name}`
  if (entry.type === "directory" || entry.path.endsWith("/") || entry.path.endsWith("\\")) return { path, kind: "directory" }
  return { path, kind: pathKind(path, projectRoot) }
}

function filterGlob(result: Tool.Result, ignoreLib: IgnoreLib, projectRoot: string): Tool.Result {
  if (!Array.isArray(result.output)) return filteredResult(result, [], "No files found", keptMetadata(result.metadata, "count", 0))
  const entries = result.output.flatMap((entry) => {
    const parsed = globEntry(entry)
    if (!parsed) return []
    if (matchesIgnore(ignoreLib, entryTarget(".", parsed, projectRoot), projectRoot)) return []
    return [parsed]
  })
  const truncated = result.metadata?.truncated === true
  const window = result.output.length
  return filteredResult(
    result,
    entries,
    globModelContent(entries, projectRoot, truncated, window, window - entries.length),
    keptMetadata(result.metadata, "count", entries.length),
  )
}

function filterGrep(result: Tool.Result, ignoreLib: IgnoreLib, projectRoot: string): Tool.Result {
  if (!Array.isArray(result.output)) return filteredResult(result, [], "No matches found", keptMetadata(result.metadata, "matches", 0))
  const kept = result.output.flatMap((match) => {
    const parsed = grepMatch(match)
    if (!parsed) return []
    if (matchesIgnore(ignoreLib, { path: parsed.entry.path, kind: "file" }, projectRoot)) return []
    return [{ match, parsed }]
  })
  const truncated = result.metadata?.truncated === true
  const window = result.output.length
  return filteredResult(
    result,
    kept.map((item) => item.match),
    grepModelContent(kept.map((item) => item.parsed), projectRoot, truncated, window, window - kept.length),
    keptMetadata(result.metadata, "matches", kept.length),
  )
}

function filterRead(result: Tool.Result, input: unknown, ignoreLib: IgnoreLib, projectRoot: string): Tool.Result {
  const page = listPage(result.output)
  if (!page) return filterFileRead(result, input, ignoreLib, projectRoot)
  const directory = stringField(inputRecord(input), "path") || "."
  const entries = page.entries.filter((entry) => !matchesIgnore(ignoreLib, entryTarget(directory, entry, projectRoot), projectRoot))
  const filtered = { ...page, entries }
  return filteredResult(
    result,
    filtered,
    listModelContent(directory, numberField(inputRecord(input), "offset"), filtered),
    result.metadata ?? {},
  )
}

function pathIsIgnored(targetPath: string, ignoreLib: IgnoreLib, projectRoot: string): boolean {
  const target = { path: targetPath, kind: pathKind(targetPath, projectRoot) }
  return matchesIgnore(ignoreLib, target, projectRoot)
}

function fileReadPath(result: Tool.Result, input: unknown): string | undefined {
  if (isRecord(result.output) && typeof result.output.name === "string") {
    const requested = stringField(inputRecord(input), "path") || "."
    return join(dirname(requested), result.output.name)
  }
  if (typeof result.content === "string") {
    return result.content.match(/^Read file ([^,\r\n]+)/)?.[1]
  }
  return undefined
}

function filterFileRead(result: Tool.Result, input: unknown, ignoreLib: IgnoreLib, projectRoot: string): Tool.Result {
  const actualPath = fileReadPath(result, input)
  if (!actualPath || !pathIsIgnored(actualPath, ignoreLib, projectRoot)) return result
  const message = "Access denied: file contents blocked by ignore file. Do NOT try to read this. Access restricted."
  return { ...result, output: { type: "file", content: message, encoding: "utf8", mime: "text/plain" }, content: message, metadata: {} }
}

function filterErrorSuggestions(message: string, ignoreLib: IgnoreLib, projectRoot: string): string {
  const lines = message.split("\n")
  const marker = lines.findIndex((line) => line.includes("Did you mean"))
  if (marker < 0) return message
  const suggestions = lines.slice(marker + 1)
  const kept = suggestions.filter((line) => {
    if (!line.trim()) return true
    return !pathIsIgnored(line.trim(), ignoreLib, projectRoot)
  })
  const meaningful = kept.some((line) => line.trim())
  return [...lines.slice(0, marker), ...(meaningful ? [lines[marker], ...kept] : [])].join("\n")
}

/**
 * OpenCode v2 plugin that blocks native file tools using .ignore patterns.
 *
 * The root .ignore file is always denied, before pattern matching.
 * read, write, edit, and patch are denied before execution. glob and grep may
 * search an allowed root, then ignored paths and their previews are removed.
 */
const OpenCodeIgnore = Plugin.define({
  id: "opencode-ignore",
  async setup(ctx) {
    const projectRoot = ctx.location.directory

    await ctx.tool.hook("execute.before", async (event) => {
      const targets = targetsFor(event.tool, inputRecord(event.input), projectRoot)
      const policy = targets.find((target) => isPolicyFile(target.path, projectRoot))
      if (policy) throw new Error(denied(policy.path))

      const ignoreLib = await loadIgnore(projectRoot)
      if (!ignoreLib) return

      const blocked = targets.find((target) => matchesIgnore(ignoreLib, target, projectRoot))
      if (!blocked) return

      throw new Error(denied(blocked.path))
    })

    await ctx.tool.hook("execute.after", async (event) => {
      const ignoreLib = await loadIgnore(projectRoot)
      if (!ignoreLib) return
      if (event.status === "error") {
        if (isRecord(event.error) && typeof event.error.message === "string") {
          event.error.message = filterErrorSuggestions(event.error.message, ignoreLib, projectRoot)
        }
        return
      }

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
