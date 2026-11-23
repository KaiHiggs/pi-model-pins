# Pi Model Pins

A fast model switcher for [Pi](https://pi.dev). Your pins appear above the full list of models available from your configured providers. The picker reads Pi’s cached catalog without waiting for a network refresh.

## Install

```sh
pi install git:github.com/KaiHiggs/pi-model-pins
```

Restart Pi or run `/reload`. Tested with Pi 1.5.0. No patches to Pi are required. If you added a standalone copy of this extension earlier, move it out of your Pi extensions directory before loading the package.

## Switch models

Open the picker with **Alt+M** or `/m`. Type to search, use **↑/↓** to move, and press **Enter** to switch. **Esc** closes the picker without switching models.

- **Tab** pins or unpins the highlighted model.
- **Alt+↑/↓** reorders a pin.
- **`/m <text>`** switches immediately if exactly one pin’s provider/model ID contains the text. Otherwise it opens the picker with the search filled in.

## Where pins are stored

Pins use Pi’s global `enabledModels` setting and are saved when you close the picker. Existing exact pins are picked up automatically. Wildcards and ambiguous patterns are kept in settings but are not editable here.

**The first enabled model also affects which model Pi starts with.** Restart Pi for pin changes to affect its built-in model cycling and picker. The extension does not replace `/model` or change the current session’s model until you select one.
