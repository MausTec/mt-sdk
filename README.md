there is nothing to read

there is no code

this page was intentionally left blank

if you are here to download the SDK no you are not

# Maus-Tec Software Development Kit

This SDK provides tools for authoring event-oriented plugins for Maus-Tec Electronics
products. The primary authoring method of plugins is the MTP plugin syntax:

```mtp
# example would go here when the syntax is done
```

This syntax transpiles down to a structured JSON document which is optimized for loading
into your device's plugin system. One should not attempt to author JSON based plugins 
by hand. If, however, one has, this SDK provides a means to validate them as well.

In the near future, the SDK Runtime Simulator will be added to this repository, which will
allow running your plugins through a real runtime and simulating results, along with a
testing syntax for defining test cases for your plugins.

This SDK will provide repository scaffolding for your plugin projects to help you configure
CI (Github Actions is the default), and any other required files. It will also add code
generators for plugins, modules, and tests.

This SDK provides other tools to various development systems one might use, all in the
spirit of providing easy access to the proper means of plugin authoring for our devices.
One such tool is our integration with Visual Studio Code by means of a plugin, which provides
syntax highlighting for MTP source, a realtime language service powering variable resolution,
squiggles, hover-over data, and loud red dots by your broken MTP files. Other tools
are available throughout VS Code as well.

Please look forward to it all.
(and stop writing json)