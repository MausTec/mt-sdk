import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { OverlayDescriptor, TemplateVars } from "../types.js";
import { render } from "../render.js";

// ---------------------------------------------------------------------------
// .gitignore overlay
// ---------------------------------------------------------------------------

const GITIGNORE_TEMPLATE = `\
# mt-sdk build output
dist/

# MTP compilation artifacts 
# Note: Plugin JSON is not committed, this is a build artifact. It'd be like committing the .o files.
*.json.map
*.json

# Node
node_modules

# OS
.DS_Store
Thumbs.db
`;

export const gitignoreOverlay: OverlayDescriptor = {
  id: "gitignore",
  name: ".gitignore",
  description: "Add a .gitignore that excludes build output and commonly excluded files",
  defaultEnabled: true,

  files(_vars: TemplateVars) {
    return [
      { path: ".gitignore", content: GITIGNORE_TEMPLATE, overwrite: false },
    ];
  },

  detect(dir) {
    return existsSync(join(dir, ".gitignore"));
  },
};

// ---------------------------------------------------------------------------
// GitHub Actions CI overlay
// ---------------------------------------------------------------------------

const GITHUB_CI_TEMPLATE = `\
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  build:
    name: Build & Test
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Install mt-sdk
        run: npm install -g @maustec/mt-sdk

      - name: Build
        run: mt-sdk build

      - name: Test
        run: mt-sdk test
`;

export const githubCiOverlay: OverlayDescriptor = {
  id: "github-ci",
  name: "GitHub Actions CI",
  description: "Add a GitHub Actions workflow that builds and tests on push",
  defaultEnabled: false,

  files(_vars: TemplateVars) {
    return [
      {
        path: ".github/workflows/ci.yml",
        content: GITHUB_CI_TEMPLATE,
        overwrite: false,
      },
    ];
  },

  detect(dir) {
    const ciPath = join(dir, ".github/workflows/ci.yml");
    if (!existsSync(ciPath)) return false;
    try {
      return readFileSync(ciPath, "utf-8").includes("mt-sdk");
    } catch {
      return false;
    }
  },
};

// ---------------------------------------------------------------------------
// GitHub Actions CI Release overlay
// Build and release using GitHub Actions on TAG push
// ---------------------------------------------------------------------------

const GITHUB_CI_RELEASE_TEMPLATE = `\
name: CI Release

on:
  push:
    tags: ["v*.*.*"]

jobs:
  release:
    name: Release
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Install mt-sdk
        run: npm install -g @maustec/mt-sdk

      - name: Build
        run: mt-sdk build

      - name: Release
        run: mt-sdk release
`;

export const githubCiReleaseOverlay: OverlayDescriptor = {
  id: "github-ci-release",
  name: "GitHub Actions CI Release",
  description: "Add a GitHub Actions workflow for release builds",
  defaultEnabled: false,

  files(_vars: TemplateVars) {
    return [
      {
        path: ".github/workflows/release.yml",
        content: GITHUB_CI_RELEASE_TEMPLATE,
        overwrite: false,
      },
    ];
  },

  detect(dir) {
    const releasePath = join(dir, ".github/workflows/release.yml");
    if (!existsSync(releasePath)) return false;
    try {
      return readFileSync(releasePath, "utf-8").includes("mt-sdk");
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// License overlay
// ---------------------------------------------------------------------------

const MIT_TEMPLATE = `\
MIT License

Copyright (c) {{ year }} {{ author }}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

const APACHE2_TEMPLATE = `\
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

Copyright {{ year }} {{ author }}

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
`;

export const licenseOverlay: OverlayDescriptor = {
  id: "license",
  name: "License file",
  description: "Add a LICENSE file (MIT, Apache-2.0, or none)",
  defaultEnabled: false,

  files(vars) {
    const licenseId = vars["license"] ?? "MIT";
    let template: string;

    switch (licenseId) {
      case "Apache-2.0":
        template = APACHE2_TEMPLATE;
        break;
      case "MIT":
      default:
        template = MIT_TEMPLATE;
        break;
    }

    return [
      {
        path: "LICENSE",
        content: render(template, vars),
        overwrite: false,
      },
    ];
  },

  detect(dir) {
    return existsSync(join(dir, "LICENSE")) || existsSync(join(dir, "LICENSE.md"));
  },
};

// ---------------------------------------------------------------------------
// README overlay
// ---------------------------------------------------------------------------

const README_PLUGIN_TEMPLATE = `\
# {{ display_name }}

> A Maus-Tec plugin built with [mt-sdk](https://github.com/maustec/mt-sdk).

## Development

\`\`\`sh
# Build
mt-sdk build

# Run tests
mt-sdk test
\`\`\`

## License

{{ license }}
`;

const README_UMBRELLA_TEMPLATE = `\
# {{ name }}

A Maus-Tec plugin workspace.

## Structure

\`\`\`
plugins/
  <plugin-name>/
    plugin.mtp
    tests/
\`\`\`

## Development

\`\`\`sh
# Build all plugins
mt-sdk build

# Run all tests
mt-sdk test
\`\`\`
`;

export const readmeOverlay: OverlayDescriptor = {
  id: "readme",
  name: "README",
  description: "Add a README.md with development instructions",
  defaultEnabled: true,

  files(vars) {
    const template =
      vars["kind"] === "umbrella" ? README_UMBRELLA_TEMPLATE : README_PLUGIN_TEMPLATE;
    return [
      {
        path: "README.md",
        content: render(template, vars),
        overwrite: false,
      },
    ];
  },

  detect(dir) {
    return existsSync(join(dir, "README.md"));
  },
};
