# Maus-Tec Software Development Kit

`mt-sdk` is the toolkit for building plugins for Maus-Tec Electronics devices,
like the Edge-o-Matic 3000. Plugins are written in MTP, a small language made
specifically for this job, and this SDK gives you everything you need to
write, test, and package them.

With `mt-sdk` you can:

- Scaffold a new plugin project in seconds
- Validate your plugin against the device's API before you ever touch hardware
- Simulate events against your plugin and see exactly what it does
- Write and run automated tests for your plugin's logic
- Build your `.mtp` source down to the `plugin.json` the device actually loads

## Installation

You'll need Node.js 20 or later. Install the CLI globally:

```bash
npm install -g @maustec/mt-sdk
```

Or add it to a project as a dev dependency for building your own tooling:

```bash
npm install --save-dev @maustec/mt-sdk
```

We also publish a [VS Code extension](./vscode/README.md) that adds syntax
highlighting and live error checking for `.mtp` files. Install "Maus-Tec Plugin
Syntax" from the Marketplace once you have a plugin project open.

## Quick start

Scaffold a new plugin:

```bash
mt-sdk init my-plugin
```

This asks you a few questions (plugin type, target platform, and so on) and
generates a ready-to-edit project. If you'd rather skip the prompts, pass
flags directly:

```bash
mt-sdk init my-plugin --type plugin --plugin-type feature --platforms eom3k
```

Once you have a `plugin.mtp` file, you can validate it:

```bash
mt-sdk validate plugin.mtp
```

Simulate an event to see what your plugin would actually do:

```bash
mt-sdk simulate plugin.mtp --event speed_change --arg 128
```

Run any tests you've written for it:

```bash
mt-sdk test
```

And build your `.mtp` source into the JSON the device loads (specifying the filename is optional):

```bash
mt-sdk build plugin.mtp
```

## The MTP language

MTP plugins describe how a device should react to events, like a Bluetooth
connection or a speed change from the app. A plugin declares some metadata,
optional configuration and BLE matching rules, and then a set of event
handlers that run your logic.

Here's a real plugin, the Lovense BLE driver, shortened slightly:

```elixir
defplugin LovenseDriver do
  @display_name "Lovense Driver"
  @version      "1.0.0"
  @sdk_version  "~> 1.1.0"
  @type         "ble_driver"
  @description  "BLE driver for Lovense single vibration motor toys"
  @author       "Maus-Tec Electronics"
  @license      "MIT"
  @platforms    ["eom3k >= 2.0.2"]
  @permissions  ["ble:write"]

  match do
    ble_name_prefix "LVS-"
  end

  config do
    # Vibration Max Level
    int max_level = 20, min: 0, max: 5
  end

  globals do
    int state = 0
  end

  # Maps a 0-255 speed value to a 0-max_level motor command value.
  fn map_speed = (int arg) -> round(arg * config.max_level / 255)

  on :connect do
    log "lovense: connected"
    ble_write "Battery;"
  end

  on :speed_change with speed do
    speed |> map_speed() |> to_string() |> concat("Vibrate:", $_, ";") |> ble_write()
  end
end
```

A few things worth pointing out:

- This language feels like Elixir. If your IDE does not support the Maus-Tec
  Plugin syntax extensions, you can render *.mtp files as Elixir for some 
  sort of syntax highlighting. 
- Every plugin starts with `defplugin Name do ... end` and a block of
  `@metadata` attributes at the top.
- `match do ... end` tells the device which hardware this plugin applies to.
  For BLE drivers, that's usually a `ble_name_prefix`. Other match types will
  be developed in the future.
- `config do ... end` declares settings your plugin exposes to the user, with
  a type, a default value, and optional constraints like `min` and `max`. You
  read them back later with `config.name`. Config names are taken from the 
  comment immediately preceeding the config definition.
- `globals do ... end` declares state that persists between events, for
  example `int state = 0`. You read and write globals with a `$` prefix, like
  `$state`.
- `fn` defines a short, single-expression function. Since a single expression
  includes pipe chains, `fn` defs are useful for aliasing pipe chain transformations.
  `def ... do ... end` function blocks define a longer function which is made of
  multiple expressions, and can also include local variable scope. Note that 
  variables must be declared first ("hoisted", if you will).
- `on :event_name do ... end` handles an event. If the event carries a value,
  name it with `with`, like `on :speed_change with speed do ... end`.
- The `|>` pipe operator passes the result of one call into the next as its
  final argument, and `$_` refers to that piped-in value if you need it in 
  another position, explicitly. This keeps chains like "convert to string, then wrap in a
  command, then send over BLE" readable top to bottom. The underlying runtime
  executes actions as a series of steps, so the pipe operator helps write 
  efficient plugins that mirror this mental model.

Plugins are tested with a companion `.test.mtp` file. Tests mock out the host
functions your plugin calls (like `ble_write` or `log`), emit events, and
assert on the resulting globals or calls:

```mtp
deftest for LovenseDriver do
  mock ble_write = (string data) -> 0

  describe "speed_change" do
    test "sends a vibrate command scaled to max_level" do
      emit :speed_change with 255
      expect ble_write called with "Vibrate:20;"
    end
  end
end
```

Run `mt-sdk test` from your project directory to execute all `.test.mtp`
files.

## More examples

The [eom-plugins repository](https://github.com/maustec/eom-plugins) contains
real, in-use plugins for the Edge-o-Matic 3000, including BLE drivers and
feature plugins, each with their own tests. It's the best place to see the
language used in practice and to find a starting point close to what you're
building.

## License

MIT