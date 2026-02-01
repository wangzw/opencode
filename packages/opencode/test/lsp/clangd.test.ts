import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import os from "node:os"
import path from "node:path"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { LSPServer } from "../../src/lsp/server"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"

describe("LSPServer.Clangd", () => {
  let tmpDir: string

  beforeEach(async () => {
    await Log.init({ print: true })
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "opencode-clangd-test-"))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  describe("root detection", () => {
    test("returns directory containing .clangd file", async () => {
      // Create project structure:
      // tmpDir/
      //   .clangd
      //   src/
      //     main.cpp
      await writeFile(path.join(tmpDir, ".clangd"), "")
      await mkdir(path.join(tmpDir, "src"))
      const cppFile = path.join(tmpDir, "src", "main.cpp")
      await writeFile(cppFile, "#include <iostream>")

      const root = await Instance.provide({
        directory: tmpDir,
        fn: () => LSPServer.Clangd.root(cppFile),
      })

      expect(root).toBe(tmpDir)
    })

    test("returns Instance.directory as fallback when no .clangd file exists", async () => {
      // Create project structure:
      // tmpDir/
      //   src/
      //     main.cpp
      // Note: compile_flags.txt is NOT used for root detection
      // clangd will find it automatically from working directory or parent directories
      await mkdir(path.join(tmpDir, "src"))
      const cppFile = path.join(tmpDir, "src", "main.cpp")
      await writeFile(cppFile, "#include <iostream>")

      const root = await Instance.provide({
        directory: tmpDir,
        fn: () => LSPServer.Clangd.root(cppFile),
      })

      expect(root).toBe(tmpDir)
    })

    test("finds .clangd in subdirectory (git subtree scenario)", async () => {
      // Create project structure (git subtree scenario):
      // tmpDir/
      //   .clangd              (project root)
      //   libs/
      //     mylib/             (git subtree)
      //       .clangd          (subtree-specific config)
      //       src/
      //         lib.cpp
      await writeFile(path.join(tmpDir, ".clangd"), "")
      const subtree = path.join(tmpDir, "libs", "mylib")
      await mkdir(subtree, { recursive: true })
      await writeFile(path.join(subtree, ".clangd"), "")
      await mkdir(path.join(subtree, "src"))
      const cppFile = path.join(subtree, "src", "lib.cpp")
      await writeFile(cppFile, "#include <vector>")

      const root = await Instance.provide({
        directory: tmpDir,
        fn: () => LSPServer.Clangd.root(cppFile),
      })

      // Should find the nearest .clangd file (in subtree)
      expect(root).toBe(subtree)
    })
  })

  describe("findCompileCommandsDir", () => {
    test("finds compile_commands.json in CMake build directory (highest priority)", async () => {
      // Create project structure:
      // tmpDir/
      //   CMakeLists.txt
      //   build/
      //     CMakeCache.txt
      //     compile_commands.json
      //   compile_commands.json  (should NOT be used)
      await writeFile(path.join(tmpDir, "CMakeLists.txt"), "cmake_minimum_required(VERSION 3.10)")
      await writeFile(path.join(tmpDir, "compile_commands.json"), "[]")
      const buildDir = path.join(tmpDir, "build")
      await mkdir(buildDir)
      await writeFile(path.join(buildDir, "CMakeCache.txt"), "")
      await writeFile(path.join(buildDir, "compile_commands.json"), "[]")

      const result = await Instance.provide({
        directory: tmpDir,
        fn: () => LSPServer.findCompileCommandsDir(tmpDir),
      })

      expect(result).toBe(buildDir)
    })

    test("finds compile_commands.json in root directory when no CMake build", async () => {
      // Create project structure:
      // tmpDir/
      //   compile_commands.json
      await writeFile(path.join(tmpDir, "compile_commands.json"), "[]")

      const result = await Instance.provide({
        directory: tmpDir,
        fn: () => LSPServer.findCompileCommandsDir(tmpDir),
      })

      expect(result).toBe(tmpDir)
    })

    test("finds compile_commands.json in first-level subdirectory", async () => {
      // Create project structure:
      // tmpDir/
      //   out/
      //     compile_commands.json
      const outDir = path.join(tmpDir, "out")
      await mkdir(outDir)
      await writeFile(path.join(outDir, "compile_commands.json"), "[]")

      const result = await Instance.provide({
        directory: tmpDir,
        fn: () => LSPServer.findCompileCommandsDir(tmpDir),
      })

      expect(result).toBe(outDir)
    })

    test("returns undefined when compile_commands.json not found", async () => {
      // Create project structure:
      // tmpDir/
      //   (empty)

      const result = await Instance.provide({
        directory: tmpDir,
        fn: () => LSPServer.findCompileCommandsDir(tmpDir),
      })

      expect(result).toBeUndefined()
    })

    test("prefers CMake build directory over root directory", async () => {
      // Create project structure:
      // tmpDir/
      //   compile_commands.json  (should NOT be used)
      //   build-debug/
      //     CMakeCache.txt
      //     compile_commands.json  (should be used)
      await writeFile(path.join(tmpDir, "compile_commands.json"), "[]")
      const buildDir = path.join(tmpDir, "build-debug")
      await mkdir(buildDir)
      await writeFile(path.join(buildDir, "CMakeCache.txt"), "")
      await writeFile(path.join(buildDir, "compile_commands.json"), "[]")

      const result = await Instance.provide({
        directory: tmpDir,
        fn: () => LSPServer.findCompileCommandsDir(tmpDir),
      })

      expect(result).toBe(buildDir)
    })

    test("finds compile_commands.json when multiple CMake build directories exist", async () => {
      // Create project structure:
      // tmpDir/
      //   build-debug/
      //     CMakeCache.txt
      //     compile_commands.json
      //   build-release/
      //     CMakeCache.txt
      //     compile_commands.json
      const debugDir = path.join(tmpDir, "build-debug")
      const releaseDir = path.join(tmpDir, "build-release")
      await mkdir(debugDir)
      await mkdir(releaseDir)
      await writeFile(path.join(debugDir, "CMakeCache.txt"), "")
      await writeFile(path.join(debugDir, "compile_commands.json"), "[]")
      await writeFile(path.join(releaseDir, "CMakeCache.txt"), "")
      await writeFile(path.join(releaseDir, "compile_commands.json"), "[]")

      const result = await Instance.provide({
        directory: tmpDir,
        fn: () => LSPServer.findCompileCommandsDir(tmpDir),
      })

      // Should find one of the CMake build directories (order is filesystem-dependent)
      expect([debugDir, releaseDir]).toContain(result)
    })

    test("skips CMake build directories without compile_commands.json", async () => {
      // Create project structure:
      // tmpDir/
      //   compile_commands.json  (should be used as fallback)
      //   build/
      //     CMakeCache.txt
      //     (no compile_commands.json)
      await writeFile(path.join(tmpDir, "compile_commands.json"), "[]")
      const buildDir = path.join(tmpDir, "build")
      await mkdir(buildDir)
      await writeFile(path.join(buildDir, "CMakeCache.txt"), "")

      const result = await Instance.provide({
        directory: tmpDir,
        fn: () => LSPServer.findCompileCommandsDir(tmpDir),
      })

      expect(result).toBe(tmpDir)
    })
  })

  describe("extensions", () => {
    test("supports C/C++ file extensions", () => {
      const extensions = LSPServer.Clangd.extensions
      expect(extensions).toContain(".c")
      expect(extensions).toContain(".cpp")
      expect(extensions).toContain(".cc")
      expect(extensions).toContain(".cxx")
      expect(extensions).toContain(".c++")
      expect(extensions).toContain(".h")
      expect(extensions).toContain(".hpp")
      expect(extensions).toContain(".hh")
      expect(extensions).toContain(".hxx")
      expect(extensions).toContain(".h++")
    })
  })
})
