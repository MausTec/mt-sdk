# Maus-Tec Plugin Syntax

This extension adds editor support for MTP, the language used to write
plugins for Maus-Tec Electronics devices. It's the companion to the
[`mt-sdk`](https://www.npmjs.com/package/@maustec/mt-sdk) command line tool,
and works with any `.mtp` or `.test.mtp` file.

## Features

- **Syntax highlighting** for `.mtp` plugin files and `.test.mtp` test files.
- **Live diagnostics** for `.mtp` files. Unknown variables, undefined
  functions, wrong argument counts, and other mistakes are underlined as you
  type, without needing to run `mt-sdk build` first.
- **Hover information** for config values, globals, and functions defined in
  your plugin.
- An MCP server that lets AI agents in VS Code call the same validation and
  simulation tools the CLI uses, so an agent helping you write a plugin can
  check its own work.

Everything runs locally. No part of your plugin source is sent anywhere. AI
features are optional and execute in whatever workflow you already have set up.
We don't include anything more than the tools to ensure that, should one
feel the need to vibe code, their model doesn't waste our planet's resources 
guessing about how to develop plugins.

## Getting started

1. Install this extension from the Marketplace.
2. Open a folder containing a `plugin.mtp` file, or scaffold a new one with
   the `mt-sdk` CLI:

   ```bash
   npm install -g @maustec/mt-sdk
   mt-sdk init my-plugin
   ```

3. Open `plugin.mtp` in the editor. You should see syntax highlighting
   immediately, and any errors in your plugin will be underlined within a
   moment.

You don't need `mt-sdk` installed to get syntax highlighting, but you'll want
it for building, testing, and simulating your plugin from the command line.
See the [mt-sdk README](https://github.com/maustec/mt-sdk#readme) for details
on the CLI and the language itself.

**Note:** A future update for this extension will include built-in build/test
tools, we just haven't gotten there yet. We're also looking into a way to 
provide the mt-sdk CLI to the built-in terminal.

## Example

Here's what a small plugin looks like. This one pops up a little message
whenever the speed reaches 100:

```elixir
defplugin ExamplePlugin do
  @display_name "Example Plugin"
  @version      "0.1.0"
  @sdk_version  "~> 1.1.0"
  @type         "feature"
  @description  "Speed based alert."
  @author       "Your Name"
  @license      "MIT"
  @platforms    ["eom3k ~> 2.1.0"]
  @permissions  ["ui:notify"]

  on :speed_change with speed do
    if speed >= 100 do
       notify("Woah there, buddy! Yer gonna cum at those speeds!")
    end
  end
end
```

Open a file like this and you'll see the extension highlight the
`defplugin`/`do`/`end` keywords, the `@metadata` attributes, and the `on`
event handler differently, along with catching things like a typo in
`notify` or a reference to a config value that doesn't exist.

## More examples

For real plugins to read through or copy from, see the
[eom-plugins repository](https://github.com/maustec/eom-plugins). It has BLE
drivers and feature plugins for the Edge-o-Matic 3000, each with tests.

## License

MIT
