# opencode-ignore

OpenCode v2 plugin to restrict AI access to files and directories using `.ignore` patterns (gitignore-style).

This repository is a fork of [lgladysz/opencode-ignore](https://github.com/lgladysz/opencode-ignore) by [Łukasz Gładysz](https://github.com/lgladysz). The ignore matching comes from that project. This fork adapts the plugin to OpenCode v2.

> **Disclaimer:** `opencode-ignore` is an independent project. It is not built by the OpenCode team and is not affiliated with OpenCode.

## Usage

Add to your OpenCode configuration (`~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "opencode-ignore"
  ]
}
```

Create a `.ignore` file in your project root with patterns to block:

```gitignore
# Block specific directory
/secrets/**

# Block all certificate files
*.crt
*.key
*.pem

# Block environment files
.env*

# Allow exception with negation
!config.local.json
```

## `.ignore` Format

The `.ignore` file follows gitignore-style syntax powered by the [`ignore`](https://github.com/kaelzhang/node-ignore) package.

### Pattern Types

#### Absolute Paths
Block specific paths from project root:
```gitignore
/to/ignore
/somedir/toignore/**
```

#### Glob Patterns
Block files matching patterns anywhere in project:
```gitignore
**/node_modules/**
**/dist/**
**/build/**
**/.cache/**
```

#### Wildcards
Block files by extension or name pattern:
```gitignore
*.crt              # All certificate files
*.key              # All private keys
*.pem              # All PEM files
*-secret.json      # Files ending with "-secret.json"
temp*.log          # Temp log files
```

#### Negation Patterns
Allow exceptions to blocked patterns:
```gitignore
*.json              # Block all JSON files
!*.local.json       # But allow *.local.json files

**/target/**        # Block target directory
!**/target/**       # Re-allow it (negation)
```

### Directory vs File Matching

The `ignore` library automatically detects whether paths are files or directories:

```gitignore
foo      # Blocks file "foo" OR directory "foo/"
foo/     # Only blocks directory "foo/"
```

**Important**: Pattern `**/node_modules/**` blocks files *inside* the directory, not the directory itself.

## Example Patterns

See `example/.ignore` for comprehensive examples:

```gitignore
# Block specific paths
/secrets/**
/private/**
!/private/public-config.json

# Block directories anywhere
**/node_modules/**
**/dist/**
**/build/**
**/.cache/**

# Block sensitive files
*-secret.json
temp*.log
*.crt
*.key
*.pem
.env*
.env
*.env
id_rsa
id_ed25519
secrets.json
credentials.json
api-keys.json

# Allow build artifacts in specific cases (negation)
!**/dist/public/**

# Allow local development files
!*.local.json
!*.dev.json
!config.development.json
!/.local/
```

## Supported Tools

The plugin protects the following OpenCode v2 native tools. Paths are the `path` argument (`patch` uses paths inside `patchText`).

### File operations (blocked before execution)
- `read` - Blocks reading an ignored file. Reading a directory lists that directory; ignored children are removed from the listing and its preview.
- `write` - Blocks writing an ignored path
- `edit` - Blocks editing an ignored file
- `patch` - Blocks the whole patch when any `*** Add File:`, `*** Update File:`, `*** Move to:`, or `*** Delete File:` path is ignored

The project `.ignore` file is always denied for `read`, `write`, `edit`, `patch`, `glob`, and `grep`, even when no pattern matches it. Glob results, grep matches, and directory listings drop it as well. On Windows, `.Ignore` is the same file. A path is checked as given and, when it is a symlink, at its canonical target. A path that leaves the project is denied.

### Search (search root blocked before execution, hits removed after)
- `glob` - Blocks an ignored search directory, then drops ignored files from the result list and the model text
- `grep` - Blocks an ignored search path, then drops ignored matches. Line previews are rebuilt from the remaining matches, so a removed file's text cannot stay in the model output

Shell commands are not intercepted. A shell command that prints a file can still reveal it.

**Protection levels**:
- **Before execution**: The tool is denied and the model receives the access-denied message (read, write, edit, patch, and a glob/grep search root)
- **After execution**: An allowed search or directory listing still has ignored paths and their previews removed (glob, grep, directory `read`)

**Note**: Project root (`.`) is always accessible.

## How It Works

### Pre-execution Protection
1. The root `.ignore` path is denied before pattern matching
2. Plugin loads `.ignore` from the project root
3. Tool paths are normalized to relative paths from the project root, and a symlink is also checked at its canonical target
4. A path that leaves the project is denied
5. Remaining paths are checked against ignore patterns using the `ignore` library
6. If matched, tool execution is blocked with a clear error message

### After-execution filtering (glob, grep, directory read)
When the search root or directory itself is allowed:
1. The tool runs
2. Ignored paths are removed from the structured result
3. The model text is rebuilt from what remains, so a line preview or directory name cannot leak
4. An empty result is reported when every hit was ignored
5. A truncated glob or grep page keeps its original window size and says that ignored hits were removed

### Graceful Degradation
- If `.ignore` is missing, paths other than the policy file itself are allowed
- Project root (`.`) is always accessible

### Error Messages

When a path is blocked:
```
Access denied: path/to/file blocked by ignore file. Do NOT try to read this. Access restricted.
```

## Path Normalization

The plugin handles various path formats:

- **Absolute paths**: Converted to relative from project root
- **Relative paths**: Used directly
- **Paths with `./`**: Prefix removed (ignore library requirement)
- **Win32 backslashes**: Auto-converted to forward slashes
- **Directory paths**: Trailing `/` added when needed

## Testing

Run tests with:
```bash
bun test
```

Tests cover:
- Absolute path patterns
- Glob patterns
- Negation patterns
- Wildcard patterns
- Directory vs file matching
- Path normalization edge cases
- All supported native tools
- Missing `.ignore` graceful degradation

## Development

```bash
# Install dependencies
bun install

# Run tests
bun test

# Build (if needed)
bun build index.ts
```

## License

[MIT](LICENSE). Copyright (c) 2025 Łukasz Gładysz.

## Related

- [Original opencode-ignore](https://github.com/lgladysz/opencode-ignore) by Łukasz Gładysz
- [`ignore`](https://github.com/kaelzhang/node-ignore) - The underlying pattern matching library
- [OpenCode v2 plugins](https://opencode.ai/v2/docs/build/plugins/)
