import { test, expect, describe, beforeAll } from "bun:test"
import { realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import OpenCodeIgnore from "./index"
import path from "path"

const TEST_PROJECT_ROOT = path.join(process.cwd(), "test-data")

interface BeforeEvent {
  tool: string
  input: Record<string, unknown>
  sessionID: string
  agent: string
  messageID: string
  id: string
}

interface ToolResult {
  output?: unknown
  content?: string | readonly { type: string; text?: string }[]
  metadata?: Record<string, unknown>
}

interface AfterEvent {
  tool: string
  input: Record<string, unknown>
  status: "completed"
  result: ToolResult
}

interface Hooks {
  before: (event: BeforeEvent) => Promise<void> | void
  after: (event: AfterEvent) => Promise<void> | void
}

async function createPlugin(projectRoot = TEST_PROJECT_ROOT): Promise<Hooks> {
  const hooks: Partial<Hooks> = {}
  await OpenCodeIgnore.setup({
    location: { directory: projectRoot },
    tool: {
      hook: async (name: string, callback: (event: BeforeEvent | AfterEvent) => Promise<void> | void) => {
        if (name === "execute.before") hooks.before = callback as Hooks["before"]
        if (name === "execute.after") hooks.after = callback as Hooks["after"]
      },
    },
  } as unknown as Parameters<typeof OpenCodeIgnore.setup>[0])

  if (!hooks.before || !hooks.after) throw new Error("plugin did not register tool hooks")
  return { before: hooks.before, after: hooks.after }
}

async function callAfter(hook: Hooks["after"], tool: string, input: Record<string, unknown>, result: ToolResult) {
  const event: AfterEvent = { tool, input, status: "completed", result }
  await hook(event)
  return event.result
}

function textOf(content: ToolResult["content"]): string {
  if (typeof content === "string") return content
  if (!content) return ""
  return content.map((part) => part.text ?? "").join("\n")
}

function callHook(hook: Hooks["before"], tool: string, input: Record<string, unknown>) {
  return Promise.resolve(hook({
    tool,
    input,
    sessionID: "test",
    agent: "test",
    messageID: "test",
    id: "test",
  }))
}

describe("OpenCodeIgnore Plugin", () => {
  test("plugin loads and registers hook", async () => {
    const hooks = await createPlugin()
    expect(hooks.before).toBeDefined()
    expect(typeof hooks.before).toBe("function")
    expect(typeof hooks.after).toBe("function")
  })

  test("graceful degradation - missing ignore file allows all", async () => {
    const tempDir = "/tmp/test-no-ignore-" + Date.now()
    const hook = (await createPlugin(tempDir)).before
    
    // Should not throw even though no ignore file exists
    expect(callHook(hook, "read", { path: "secrets.json" })).resolves.toBeUndefined()
  })

  test("project root (.) is always allowed", async () => {
    const hook = (await createPlugin()).before
    
    // All directory operations on root should be allowed
    expect(callHook(hook, "read", { path: "." })).resolves.toBeUndefined()
    expect(callHook(hook, "glob", { path: "." })).resolves.toBeUndefined()
    expect(callHook(hook, "grep", { path: "." })).resolves.toBeUndefined()
  })
})

describe("Ignore File Loading", () => {
  test("uses .ignore when available", async () => {
    // Current project has .ignore, should block secrets.json
    const hook = (await createPlugin()).before
    
    expect(callHook(hook, "read", { path: "secrets.json" }))
      .rejects.toThrow(/Access denied/)
  })

  test("loads .ignore file correctly", async () => {
    const tempDir = "/tmp/test-ignore-" + Date.now()
    
    // Create temp dir with .ignore
    await Bun.write(tempDir + "/.ignore", "blocked.txt\n")
    
    const hook = (await createPlugin(tempDir)).before
    
    expect(callHook(hook, "read", { path: "blocked.txt" }))
      .rejects.toThrow(/Access denied/)
    expect(callHook(hook, "read", { path: "allowed.txt" }))
      .resolves.toBeUndefined()
  })
})

describe("File I/O Tools Protection", () => {
  let hook: Hooks["before"]

  beforeAll(async () => {
    hook = (await createPlugin()).before
  })

  describe("read tool", () => {
    test("allows access to allowed files", async () => {
      expect(callHook(hook, "read", { path: "index.ts" })).resolves.toBeUndefined()
      expect(callHook(hook, "read", { path: "README.md" })).resolves.toBeUndefined()
    })

    test("blocks secrets.json", async () => {
      expect(callHook(hook, "read", { path: "secrets.json" }))
        .rejects.toThrow(/Access denied.*secrets\.json/)
    })

    test("blocks credentials.json", async () => {
      expect(callHook(hook, "read", { path: "credentials.json" }))
        .rejects.toThrow(/Access denied.*credentials\.json/)
    })

    test("blocks .env files", async () => {
      expect(callHook(hook, "read", { path: ".env" }))
        .rejects.toThrow(/Access denied.*\.env/)
      expect(callHook(hook, "read", { path: ".env.local" }))
        .rejects.toThrow(/Access denied.*\.env\.local/)
      expect(callHook(hook, "read", { path: "production.env" }))
        .rejects.toThrow(/Access denied.*production\.env/)
    })

    test("blocks certificate files", async () => {
      expect(callHook(hook, "read", { path: "server.crt" }))
        .rejects.toThrow(/Access denied.*server\.crt/)
      expect(callHook(hook, "read", { path: "ca.pem" }))
        .rejects.toThrow(/Access denied.*ca\.pem/)
      expect(callHook(hook, "read", { path: "private.key" }))
        .rejects.toThrow(/Access denied.*private\.key/)
    })

    test("blocks id_rsa", async () => {
      expect(callHook(hook, "read", { path: "id_rsa" }))
        .rejects.toThrow(/Access denied.*id_rsa/)
    })
  })

  describe("write tool", () => {
    test("allows writing to allowed files", async () => {
      expect(callHook(hook, "write", { path: "output.txt" })).resolves.toBeUndefined()
    })

    test("blocks writing to secrets.json", async () => {
      expect(callHook(hook, "write", { path: "secrets.json" }))
        .rejects.toThrow(/Access denied.*secrets\.json/)
    })
  })

  describe("edit tool", () => {
    test("allows editing allowed files", async () => {
      expect(callHook(hook, "edit", { path: "index.ts" })).resolves.toBeUndefined()
    })

    test("blocks editing secrets.json", async () => {
      expect(callHook(hook, "edit", { path: "secrets.json" }))
        .rejects.toThrow(/Access denied.*secrets\.json/)
    })
  })
})

describe("Search and directory read protection", () => {
  let hook: Hooks["before"]

  beforeAll(async () => {
    hook = (await createPlugin()).before
  })

  describe("glob tool", () => {
    test("allows glob on project root", async () => {
      expect(callHook(hook, "glob", {path: "."})).resolves.toBeUndefined()
    })

    test("allows glob on allowed directories", async () => {
      expect(callHook(hook, "glob", { path: "src" })).resolves.toBeUndefined()
    })

    test("blocks glob on to/ignore (relative path)", async () => {
      expect(callHook(hook, "glob", { path: "to/ignore" }))
        .rejects.toThrow(/Access denied.*to\/ignore/)
    })

    test("defaults to . when path not provided", async () => {
      expect(callHook(hook, "glob", {})).resolves.toBeUndefined()
    })
  })

  describe("grep tool", () => {
    test("allows grep on project root", async () => {
      expect(callHook(hook, "grep", { path: "." })).resolves.toBeUndefined()
    })

    test("allows grep on allowed directories", async () => {
      expect(callHook(hook, "grep", { path: "src" })).resolves.toBeUndefined()
    })

    test("allows grep on bamboo-specs directory (pattern only blocks files inside)", async () => {
      // Pattern **/bamboo-specs/** blocks files inside, not the directory itself
      expect(callHook(hook, "grep", { path: "foo/bamboo-specs" }))
        .resolves.toBeUndefined()
    })

    test("defaults to . when path not provided", async () => {
      expect(callHook(hook, "grep", {})).resolves.toBeUndefined()
    })
  })

  describe("directory read", () => {
    test("allows a directory read of the project root", async () => {
      expect(callHook(hook, "read", { path: "." })).resolves.toBeUndefined()
    })

    test("allows a directory read of an allowed directory", async () => {
      expect(callHook(hook, "read", { path: "src" })).resolves.toBeUndefined()
    })

    test("blocks a directory read of /to/ignore", async () => {
      expect(callHook(hook, "read", { path: "to/ignore" }))
        .rejects.toThrow(/Access denied.*to\/ignore/)
    })

    test("defaults to . when path not provided", async () => {
      expect(callHook(hook, "read", {})).resolves.toBeUndefined()
    })
  })
})

describe("Pattern Types", () => {
  let hook: Hooks["before"]

  beforeAll(async () => {
    hook = (await createPlugin()).before
  })

  describe("absolute patterns", () => {
    test("blocks /to/ignore files", async () => {
      expect(callHook(hook, "read", { path: "to/ignore/file.txt" }))
        .rejects.toThrow(/Access denied/)
    })

    test("blocks /somedir/toignore/** files", async () => {
      expect(callHook(hook, "read", { path: "somedir/toignore/nested/file.txt" }))
        .rejects.toThrow(/Access denied/)
    })
  })

  describe("glob patterns", () => {
    test("blocks **/bamboo-specs/** files", async () => {
      expect(callHook(hook, "read", { path: "foo/bamboo-specs/plan.yml" }))
        .rejects.toThrow(/Access denied/)
      expect(callHook(hook, "read", { path: "bar/baz/bamboo-specs/config.xml" }))
        .rejects.toThrow(/Access denied/)
    })

    test("allows bamboo-specs directory itself (only blocks files inside)", async () => {
      // Note: Pattern **/bamboo-specs/** blocks files inside, not the dir itself
      expect(callHook(hook, "read", { path: "bamboo-specs" })).resolves.toBeUndefined()
    })

    test("blocks **/keycloak-realm-config/templates/** files", async () => {
      expect(callHook(hook, "read", { path: "keycloak-realm-config/templates/realm.json" }))
        .rejects.toThrow(/Access denied/)
    })
  })

  describe("wildcard patterns", () => {
    test("blocks *-realm.json files", async () => {
      expect(callHook(hook, "read", { path: "dev-realm.json" }))
        .rejects.toThrow(/Access denied/)
      expect(callHook(hook, "read", { path: "prod-realm.json" }))
        .rejects.toThrow(/Access denied/)
    })

    test("blocks some*.properties files", async () => {
      expect(callHook(hook, "read", { path: "some.properties" }))
        .rejects.toThrow(/Access denied/)
      expect(callHook(hook, "read", { path: "something.properties" }))
        .rejects.toThrow(/Access denied/)
    })

    test("allows other .properties files", async () => {
      // application.properties is also matched by app*.properties pattern
      // Use a file that definitely doesn't match: sample.properties in test-data
      expect(callHook(hook, "read", { path: "test-data/sample.properties" })).resolves.toBeUndefined()
    })
  })

  describe("negation patterns", () => {
    test("allows *.local.json despite blocking patterns", async () => {
      expect(callHook(hook, "read", { path: "config.local.json" })).resolves.toBeUndefined()
      expect(callHook(hook, "read", { path: "settings.local.jsonc" })).resolves.toBeUndefined()
    })

    test("allows *.local.md files", async () => {
      expect(callHook(hook, "read", { path: "notes.local.md" })).resolves.toBeUndefined()
    })

    test("allows /.local/ directory", async () => {
      expect(callHook(hook, "read", { path: ".local" })).resolves.toBeUndefined()
      expect(callHook(hook, "read", { path: ".local/impl.md" })).resolves.toBeUndefined()
    })

    test("blocks /somedir/toignore/** but allows file-to-not-ignore.md", async () => {
      expect(callHook(hook, "read", { path: "somedir/toignore/file-to-not-ignore.md" }))
        .resolves.toBeUndefined()
      expect(callHook(hook, "read", { path: "somedir/toignore/other-file.txt" }))
        .rejects.toThrow(/Access denied/)
    })

    test("allows **/target/** due to negation", async () => {
      expect(callHook(hook, "read", { path: "target/output.jar" })).resolves.toBeUndefined()
      expect(callHook(hook, "read", { path: "target" })).resolves.toBeUndefined()
    })
  })
})

describe("Path Normalization", () => {
  let hook: Hooks["before"]

  beforeAll(async () => {
    hook = (await createPlugin()).before
  })

  describe("absolute paths", () => {
    test("handles absolute paths correctly", async () => {
      const absolutePath = path.join(TEST_PROJECT_ROOT, "secrets.json")
      expect(callHook(hook, "read", { path: absolutePath }))
        .rejects.toThrow(/Access denied/)
    })

    test("allows absolute path to allowed file", async () => {
      const absolutePath = path.join(TEST_PROJECT_ROOT, "README.md")
      expect(callHook(hook, "read", { path: absolutePath })).resolves.toBeUndefined()
    })
  })

  describe("./ prefix handling", () => {
    test("handles ./ prefix correctly", async () => {
      expect(callHook(hook, "read", { path: "./secrets.json" }))
        .rejects.toThrow(/Access denied/)
      expect(callHook(hook, "read", { path: "./index.ts" })).resolves.toBeUndefined()
    })
  })

  describe("nested directories", () => {
    test("handles deeply nested paths", async () => {
      expect(callHook(hook, "read", { path: "foo/bar/baz/bamboo-specs/plan.yml" }))
        .rejects.toThrow(/Access denied/)
      expect(callHook(hook, "read", { path: "deep/nested/path/allowed.txt" }))
        .resolves.toBeUndefined()
    })
  })

  describe("directory vs file matching", () => {
    test("directories get trailing slash for matching", async () => {
      // bamboo-specs/ as directory should be allowed (only files inside blocked)
      expect(callHook(hook, "read", { path: "bamboo-specs" })).resolves.toBeUndefined()
      
      // Files inside bamboo-specs/ should be blocked
      expect(callHook(hook, "read", { path: "bamboo-specs/file.txt" }))
        .rejects.toThrow(/Access denied/)
    })

    test(".local/ directory is allowed", async () => {
      expect(callHook(hook, "read", { path: ".local" })).resolves.toBeUndefined()
      expect(callHook(hook, "grep", { path: ".local" })).resolves.toBeUndefined()
    })
  })
})

describe("Edge Cases", () => {
  let hook: Hooks["before"]

  beforeAll(async () => {
    hook = (await createPlugin()).before
  })

  test("handles undefined path gracefully", async () => {
    // Tools like glob/grep default to "." when no path provided
    expect(callHook(hook, "glob", {})).resolves.toBeUndefined()
    expect(callHook(hook, "grep", {})).resolves.toBeUndefined()
  })

  test("handles a missing path for file tools", async () => {
    // Should not throw, just skip (no path to check)
    expect(callHook(hook, "read", {})).resolves.toBeUndefined()
  })

  test("handles empty string path", async () => {
    // Empty string should be treated as current dir
    expect(callHook(hook, "read", { path: "" })).resolves.toBeUndefined()
  })

  test("denies a path that leaves the project", async () => {
    const outside = process.platform === "win32" ? "C:\\Windows\\win.ini" : "/etc/passwd"
    expect(callHook(hook, "read", { path: "../secrets.json" })).rejects.toThrow(/Access denied/)
    expect(callHook(hook, "read", { path: "src/../../outside.txt" })).rejects.toThrow(/Access denied/)
    expect(callHook(hook, "write", { path: outside })).rejects.toThrow(/Access denied/)
  })

  test("still denies an in-project path that contains a parent segment", async () => {
    expect(callHook(hook, "read", { path: "src/../secrets.json" }))
      .rejects.toThrow(/Access denied.*secrets\.json/)
  })

  test("ignores unsupported tools", async () => {
    // Tool that's not in extractPathFromTool should be skipped
    expect(callHook(hook, "unknown_tool", { somePath: "secrets.json" }))
      .resolves.toBeUndefined()
  })

  test("error message includes blocked path", async () => {
    try {
      await callHook(hook, "read", { path: "secrets.json" })
      expect(false).toBe(true) // Should not reach here
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : ""
      expect(message).toContain("secrets.json")
      expect(message).toContain("blocked by ignore file")
      expect(message).toContain("Access denied")
    }
  })
})

describe("Real-world Scenarios", () => {
  let hook: Hooks["before"]

  beforeAll(async () => {
    hook = (await createPlugin()).before
  })

  test("allows normal development workflow", async () => {
    // Reading source files
    expect(callHook(hook, "read", { path: "index.ts" })).resolves.toBeUndefined()
    expect(callHook(hook, "read", { path: "README.md" })).resolves.toBeUndefined()
    
    // Writing output
    expect(callHook(hook, "write", { path: "output.txt" })).resolves.toBeUndefined()
    
    // Searching codebase
    expect(callHook(hook, "grep", { path: "src" })).resolves.toBeUndefined()
    expect(callHook(hook, "glob", { path: "." })).resolves.toBeUndefined()
  })

  test("blocks sensitive files consistently", async () => {
    const sensitiveFiles = [
      "secrets.json",
      "credentials.json",
      ".env",
      ".env.production",
      "server.crt",
      "private.key",
      "id_rsa"
    ]

    for (const file of sensitiveFiles) {
      expect(callHook(hook, "read", { path: file }))
        .rejects.toThrow(/Access denied/)
    }
  })

  test("handles complex project structure", async () => {
    // Should allow src directory
    expect(callHook(hook, "read", { path: "src" })).resolves.toBeUndefined()
    
    // But block bamboo-specs inside any directory
    expect(callHook(hook, "read", { path: "src/bamboo-specs/plan.yml" }))
      .rejects.toThrow(/Access denied/)
  })
})

describe("Patch Tool Protection", () => {
  let hook: Hooks["before"]

  beforeAll(async () => {
    hook = (await createPlugin()).before
  })

  test("blocks add, update, move, and delete paths", async () => {
    const patchText = `*** Begin Patch
*** Add File: secrets.json
+secret
*** Update File: src/app.ts
*** Move to: credentials.json
*** Delete File: private.key
*** End Patch`
    expect(callHook(hook, "patch", { patchText })).rejects.toThrow(/Access denied.*secrets\.json/)
  })

  test("blocks a move onto an ignored path when the source is allowed", async () => {
    const patchText = `*** Begin Patch
*** Update File: README.md
*** Move to: .env
*** End Patch`
    expect(callHook(hook, "patch", { patchText })).rejects.toThrow(/Access denied.*\.env/)
  })

  test("allows a patch that only touches ignored-exception files", async () => {
    const patchText = `*** Begin Patch
*** Update File: config.local.json
*** Delete File: notes.local.md
*** End Patch`
    expect(callHook(hook, "patch", { patchText })).resolves.toBeUndefined()
  })

  test("blocks grep of an ignored file path", async () => {
    expect(callHook(hook, "grep", { pattern: "password", path: "secrets.json" }))
      .rejects.toThrow(/Access denied.*secrets\.json/)
  })
})

describe("Glob Tool Result Filtering", () => {
  let afterHook: Hooks["after"]

  beforeAll(async () => {
    afterHook = (await createPlugin()).after
  })

  function globResult(paths: string[], content: string): ToolResult {
    return {
      output: paths.map((entry) => ({ path: entry, type: "file" })),
      content: [{ type: "text", text: content }],
      metadata: { count: paths.length, truncated: false },
    }
  }

  test("filters blocked files from glob results", async () => {
    const filtered = await callAfter(afterHook, "glob", { pattern: "**/*" }, globResult(
      ["index.ts", "secrets.json", "credentials.json", "README.md", ".env", "config.local.json"],
      ["index.ts", "secrets.json", "credentials.json", "README.md", ".env", "config.local.json"].join("\n"),
    ))

    const output = filtered.output as { path: string }[]
    expect(output.map((entry) => entry.path)).toEqual(["index.ts", "README.md", "config.local.json"])
    expect(textOf(filtered.content)).not.toContain("secrets.json")
    expect(textOf(filtered.content)).not.toContain(".env")
    expect(textOf(filtered.content)).toContain("index.ts")
    expect(filtered.metadata?.count).toBe(3)
  })

  test("filters certificate and key files", async () => {
    const filtered = await callAfter(afterHook, "glob", { pattern: "**/*" }, globResult(
      ["server.crt", "private.key", "ca.pem", "README.md"],
      "server.crt\nprivate.key\nca.pem\nREADME.md",
    ))

    expect((filtered.output as { path: string }[]).map((entry) => entry.path)).toEqual(["README.md"])
  })

  test("returns empty array when all files blocked", async () => {
    const filtered = await callAfter(afterHook, "glob", { pattern: "**/*" }, globResult(
      ["secrets.json", "credentials.json", ".env", "private.key"],
      "secrets.json\ncredentials.json\n.env\nprivate.key",
    ))

    expect(filtered.output).toEqual([])
    expect(textOf(filtered.content)).toBe("No files found")
    expect(textOf(filtered.content)).not.toContain("secrets.json")
  })

  test("handles glob results with no files", async () => {
    const filtered = await callAfter(afterHook, "glob", { pattern: "**/*.xyz" }, globResult([], "No files found"))
    expect(filtered.output).toEqual([])
  })

  test("handles malformed glob results gracefully", async () => {
    const result = { output: { files: null } }
    const filtered = await callAfter(afterHook, "glob", { pattern: "**/*" }, result)
    expect(filtered).toEqual(result)
  })

  test("respects negation patterns", async () => {
    const filtered = await callAfter(afterHook, "glob", { pattern: "**/*" }, globResult(
      ["config.local.json", "settings.local.jsonc", ".local/impl.md", "secrets.json"],
      "config.local.json\nsettings.local.jsonc\n.local/impl.md\nsecrets.json",
    ))

    expect((filtered.output as { path: string }[]).map((entry) => entry.path)).toEqual([
      "config.local.json",
      "settings.local.jsonc",
      ".local/impl.md",
    ])
  })

  test("does not filter non-glob tools", async () => {
    const result = { output: [{ path: "secrets.json", type: "file" }, { path: "index.ts", type: "file" }] }
    const filtered = await callAfter(afterHook, "write", {}, result)
    expect(filtered).toEqual(result)
  })

  test("keeps the original truncation window after ignored hits are removed", async () => {
    const filtered = await callAfter(afterHook, "glob", { pattern: "**/*" }, {
      output: [
        { path: "secrets.json", type: "file" },
        { path: "credentials.json", type: "file" },
        { path: "README.md", type: "file" },
      ],
      content: "old",
      metadata: { count: 3, truncated: true },
    })

    const text = textOf(filtered.content)
    expect(text).toContain("README.md")
    expect(text).not.toContain("secrets.json")
    expect(text).toContain("showing first 3 results")
    expect(text).toContain("2 ignored hits were removed")
    expect(text).not.toContain("showing first 1")
    expect(filtered.metadata?.truncated).toBe(true)
    expect(filtered.metadata?.count).toBe(1)
  })

  test("says when a truncated page contained only ignored hits", async () => {
    const filtered = await callAfter(afterHook, "glob", { pattern: "**/*" }, {
      output: [
        { path: "secrets.json", type: "file" },
        { path: ".env", type: "file" },
      ],
      content: "old",
      metadata: { count: 2, truncated: true },
    })

    const text = textOf(filtered.content)
    expect(text).toContain("No files found")
    expect(text).toContain("showing first 2 results")
    expect(text).toContain("2 ignored hits were removed")
    expect(text).not.toContain("showing first 0")
  })

  test("rebuilds string content so a leaked path disappears", async () => {
    const filtered = await callAfter(afterHook, "glob", { pattern: "**/*" }, {
      output: [{ path: "secrets.json", type: "file" }, { path: "README.md", type: "file" }],
      content: "C:\\secret\\secrets.json\nC:\\project\\README.md",
      metadata: { count: 2, truncated: false },
    })

    expect(typeof filtered.content).toBe("string")
    expect(textOf(filtered.content)).not.toContain("secrets.json")
    expect(textOf(filtered.content)).toContain("README.md")
  })
})

describe("Grep Tool Result Filtering", () => {
  let afterHook: Hooks["after"]

  beforeAll(async () => {
    afterHook = (await createPlugin()).after
  })

  function match(file: string, line: number, text: string) {
    return { entry: { path: file, type: "file" }, line, offset: 0, text, submatches: [] }
  }

  test("filters blocked files from grep results", async () => {
    const filtered = await callAfter(afterHook, "grep", { pattern: ".*" }, {
      output: [
        match("index.ts", 10, "export"),
        match("secrets.json", 3, "password"),
        match("README.md", 1, "# opencode"),
        match(".env", 5, "API_KEY=secret"),
      ],
      content: [{ type: "text", text: "secrets.json:\n  Line 3: password\n.env:\n  Line 5: API_KEY=secret" }],
      metadata: { matches: 4, truncated: false },
    })

    const output = filtered.output as { entry: { path: string } }[]
    expect(output.map((item) => item.entry.path)).toEqual(["index.ts", "README.md"])
    expect(textOf(filtered.content)).not.toContain("password")
    expect(textOf(filtered.content)).not.toContain("API_KEY")
    expect(textOf(filtered.content)).toContain("export")
    expect(filtered.metadata?.matches).toBe(2)
  })

  test("does not leak any info about blocked files", async () => {
    const filtered = await callAfter(afterHook, "grep", { pattern: ".*" }, {
      output: [
        match("credentials.json", 7, "admin_password: secret123"),
        match("private.key", 1, "-----BEGIN PRIVATE KEY-----"),
        match("index.ts", 50, "const config"),
      ],
      content: "credentials.json:\n  Line 7: admin_password: secret123\nprivate.key:\n  Line 1: -----BEGIN PRIVATE KEY-----",
    })

    expect((filtered.output as { entry: { path: string } }[]).map((item) => item.entry.path)).toEqual(["index.ts"])
    const resultStr = JSON.stringify(filtered)
    expect(resultStr).not.toContain("credentials.json")
    expect(resultStr).not.toContain("private.key")
    expect(resultStr).not.toContain("secret123")
    expect(resultStr).not.toContain("PRIVATE KEY")
  })

  test("returns empty matches when all blocked", async () => {
    const filtered = await callAfter(afterHook, "grep", { pattern: "secret" }, {
      output: [
        match("secrets.json", 1, "secret"),
        match(".env", 2, "password"),
        match("private.key", 5, "key data"),
      ],
      content: [{ type: "text", text: "Line 1: secret" }],
    })

    expect(filtered.output).toEqual([])
    expect(textOf(filtered.content)).toBe("No matches found")
    expect(textOf(filtered.content)).not.toContain("secret")
  })

  test("handles grep results with no matches", async () => {
    const filtered = await callAfter(afterHook, "grep", { pattern: "nonexistent" }, {
      output: [],
      content: "No matches found",
    })
    expect(filtered.output).toEqual([])
  })

  test("handles malformed grep results gracefully", async () => {
    const result = { output: { matches: null } }
    const filtered = await callAfter(afterHook, "grep", { pattern: "test" }, result)
    expect(filtered).toEqual(result)
  })

  test("drops grep rows it cannot parse", async () => {
    const pathless = { line: 5, text: "some match without file" }
    const filtered = await callAfter(afterHook, "grep", { pattern: ".*" }, {
      output: [
        match("index.ts", 10, "export"),
        pathless,
        match("secrets.json", 3, "password"),
      ],
      content: "password\nsome match without file",
    })

    const output = filtered.output as unknown[]
    expect(output).toHaveLength(1)
    expect(output[0]).toMatchObject({ entry: { path: "index.ts" } })
    expect(JSON.stringify(filtered)).not.toContain("some match without file")
    expect(textOf(filtered.content)).not.toContain("password")
  })

  test("keeps the original truncation window after ignored hits are removed", async () => {
    const filtered = await callAfter(afterHook, "grep", { pattern: ".*" }, {
      output: [
        match("secrets.json", 3, "password"),
        match("index.ts", 10, "export"),
        match(".env", 1, "API_KEY"),
      ],
      content: "password",
      metadata: { matches: 3, truncated: true },
    })

    const text = textOf(filtered.content)
    expect(text).toContain("export")
    expect(text).not.toContain("password")
    expect(text).toContain("showing first 3 results")
    expect(text).toContain("2 ignored hits were removed")
    expect(text).not.toContain("showing first 1")
    expect(filtered.metadata?.truncated).toBe(true)
    expect(filtered.metadata?.matches).toBe(1)
  })

  test("respects negation patterns in grep", async () => {
    const filtered = await callAfter(afterHook, "grep", { pattern: ".*" }, {
      output: [
        match("config.local.json", 1, "config"),
        match(".local/notes.md", 5, "notes"),
        match("secrets.json", 2, "secret"),
      ],
      content: "secret",
    })

    expect((filtered.output as { entry: { path: string } }[]).map((item) => item.entry.path)).toEqual([
      "config.local.json",
      ".local/notes.md",
    ])
  })

  test("does not filter non-grep tools", async () => {
    const result = { output: [match("secrets.json", 1, "secret")] }
    const filtered = await callAfter(afterHook, "write", {}, result)
    expect(filtered).toEqual(result)
  })
})

describe("Policy file", () => {
  test("denies reading and rewriting .ignore before patterns are applied", async () => {
    const dir = path.join(tmpdir(), "opencode-ignore-policy-" + Date.now())
    await Bun.write(path.join(dir, ".ignore"), "secrets.json\n")
    await Bun.write(path.join(dir, "secrets.json"), "secret")
    await Bun.write(path.join(dir, "README.md"), "ok")
    const hooks = await createPlugin(dir)

    await expect(callHook(hooks.before, "read", { path: ".ignore" })).rejects.toThrow(/Access denied.*\.ignore/)
    await expect(callHook(hooks.before, "write", { path: ".ignore", content: "" })).rejects.toThrow(/Access denied/)
    await expect(callHook(hooks.before, "edit", { path: ".ignore", oldString: "secrets.json", newString: "!secrets.json" }))
      .rejects.toThrow(/Access denied/)
    await expect(callHook(hooks.before, "glob", { path: ".ignore" })).rejects.toThrow(/Access denied/)
    await expect(callHook(hooks.before, "grep", { path: ".ignore", pattern: "secrets" })).rejects.toThrow(/Access denied/)
    await expect(callHook(hooks.before, "patch", {
      patchText: "*** Begin Patch\n*** Update File: .ignore\n-secrets.json\n+!secrets.json\n*** End Patch",
    })).rejects.toThrow(/Access denied.*\.ignore/)
    await expect(callHook(hooks.before, "read", { path: "secrets.json" })).rejects.toThrow(/Access denied.*secrets\.json/)
    await expect(callHook(hooks.before, "read", { path: "README.md" })).resolves.toBeUndefined()

    if (process.platform === "win32") {
      await expect(callHook(hooks.before, "write", { path: ".Ignore", content: "!secrets.json\n" })).rejects.toThrow(/Access denied/)
      await expect(callHook(hooks.before, "read", { path: ".IGNORE" })).rejects.toThrow(/Access denied/)
    }

    const listed = await callAfter(hooks.after, "read", { path: "." }, {
      output: {
        type: "list-page",
        entries: [
          { path: process.platform === "win32" ? ".Ignore" : ".ignore", type: "file" },
          { path: "README.md", type: "file" },
          { path: "secrets.json", type: "file" },
        ],
        truncated: false,
      },
      content: ".ignore\nsecrets.json\nsecret",
    })
    const entries = (listed.output as { entries: { path: string }[] }).entries.map((entry) => entry.path)
    expect(entries).toEqual(["README.md"])
    expect(textOf(listed.content)).not.toContain("secret")
    expect(textOf(listed.content).toLowerCase()).not.toContain(".ignore")

    rmSync(dir, { recursive: true, force: true })
  })

  test("hides the policy file from glob and grep results", async () => {
    const afterHook = (await createPlugin()).after
    const globbed = await callAfter(afterHook, "glob", { pattern: "**/*" }, {
      output: [
        { path: ".ignore", type: "file" },
        { path: "README.md", type: "file" },
      ],
      content: ".ignore\nREADME.md",
      metadata: { count: 2, truncated: false },
    })
    expect((globbed.output as { path: string }[]).map((entry) => entry.path)).toEqual(["README.md"])
    expect(textOf(globbed.content)).not.toContain(".ignore")

    const grepped = await callAfter(afterHook, "grep", { pattern: "secrets" }, {
      output: [
        { entry: { path: ".ignore", type: "file" }, line: 30, offset: 0, text: "secrets.json", submatches: [] },
        { entry: { path: "README.md", type: "file" }, line: 1, offset: 0, text: "opencode", submatches: [] },
      ],
      content: "secrets.json",
      metadata: { matches: 2, truncated: false },
    })
    expect((grepped.output as { entry: { path: string } }[]).map((item) => item.entry.path)).toEqual(["README.md"])
    expect(JSON.stringify(grepped)).not.toContain("secrets.json")
  })
})

describe("Symlink targets", () => {
  test("denies a link whose canonical target is ignored or outside the project", async () => {
    const dir = path.join(tmpdir(), "opencode-ignore-link-" + Date.now())
    const outside = path.join(tmpdir(), "opencode-ignore-outside-" + Date.now())
    const sensitive = path.join(dir, "sensitive-data")
    const alias = path.join(dir, "alias")
    const leak = path.join(dir, "leak")
    await Bun.write(path.join(dir, ".ignore"), "/sensitive-data/**\n")
    await Bun.write(path.join(sensitive, "credentials.json"), "secret")
    await Bun.write(path.join(dir, "README.md"), "ok")
    await Bun.write(path.join(outside, "secret.txt"), "outside-secret")
    // File symlinks need an extra privilege on Windows. A directory junction resolves through the same realpath check.
    if (process.platform === "win32") {
      symlinkSync(sensitive, alias, "junction")
      symlinkSync(outside, leak, "junction")
    } else {
      symlinkSync(path.join(sensitive, "credentials.json"), alias)
      symlinkSync(path.join(outside, "secret.txt"), leak)
    }
    const hidden = process.platform === "win32" ? "alias/credentials.json" : "alias"
    const escaped = process.platform === "win32" ? "leak/secret.txt" : "leak"
    const hooks = await createPlugin(dir)

    await expect(callHook(hooks.before, "read", { path: hidden })).rejects.toThrow(/Access denied/)
    await expect(callHook(hooks.before, "read", { path: escaped })).rejects.toThrow(/Access denied/)
    await expect(callHook(hooks.before, "read", { path: "README.md" })).resolves.toBeUndefined()
    const aliasTarget = process.platform === "win32" ? path.join(alias, "credentials.json") : alias
    expect(realpathSync(aliasTarget)).toBe(realpathSync(path.join(sensitive, "credentials.json")))

    const filtered = await callAfter(hooks.after, "glob", { pattern: "**/*" }, {
      output: [
        { path: hidden, type: "file" },
        { path: escaped, type: "file" },
        { path: "README.md", type: "file" },
      ],
      content: `${hidden}\n${escaped}\nREADME.md`,
      metadata: { count: 3, truncated: false },
    })
    expect((filtered.output as { path: string }[]).map((entry) => entry.path)).toEqual(["README.md"])
    expect(textOf(filtered.content)).toContain("README.md")
    expect(textOf(filtered.content)).not.toContain("credentials.json")
    expect(textOf(filtered.content)).not.toContain("secret.txt")

    rmSync(dir, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })
})

describe("Read Directory Result Filtering", () => {
  let afterHook: Hooks["after"]

  beforeAll(async () => {
    afterHook = (await createPlugin()).after
  })

  test("removes ignored names from a directory listing and its preview", async () => {
    const filtered = await callAfter(afterHook, "read", { path: "src", offset: 1 }, {
      output: {
        type: "list-page",
        entries: [
          { path: "index.ts", type: "file" },
          { path: "secrets.json", type: "file" },
          { path: "private.key", type: "file" },
          { path: "notes.local.md", type: "file" },
        ],
        truncated: false,
      },
      content: [{
        type: "text",
        text: "Read directory src, entries 1-4\nsrc/index.ts\nsrc/secrets.json\npassword=secret123",
      }],
      metadata: { truncated: false },
    })

    const output = filtered.output as { entries: { path: string }[] }
    expect(output.entries.map((entry) => entry.path)).toEqual(["index.ts", "notes.local.md"])
    expect(textOf(filtered.content)).toBe("Read directory src, entries 1-2\nindex.ts\nnotes.local.md")
    expect(textOf(filtered.content)).not.toContain("secrets.json")
    expect(textOf(filtered.content)).not.toContain("private.key")
    expect(textOf(filtered.content)).not.toContain("secret123")
  })

  test("removes an ignored directory from a parent listing", async () => {
    const filtered = await callAfter(afterHook, "read", { path: "to" }, {
      output: {
        type: "list-page",
        entries: [
          { path: "keep.txt", type: "file" },
          { path: "ignore\\", type: "directory" },
        ],
        truncated: false,
      },
      content: "keep.txt\nignore\nsecret inside",
    })

    const output = filtered.output as { entries: { path: string }[] }
    expect(output.entries.map((entry) => entry.path)).toEqual(["keep.txt"])
    expect(textOf(filtered.content)).toBe("Read directory to, entries 1-1\nkeep.txt")
    expect(textOf(filtered.content)).not.toContain("secret inside")
  })

  test("leaves file reads unchanged", async () => {
    const result = {
      output: { type: "file", content: "hello", encoding: "utf8", mime: "text/plain" },
      content: "Read file README.md, lines 1-1\n1: hello",
    }
    const filtered = await callAfter(afterHook, "read", { path: "README.md" }, result)
    expect(filtered).toEqual(result)
  })
})
