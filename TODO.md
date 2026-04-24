# TODO - Fix context slider UI

- [x] 1. Analyze root cause in controller/llama-host-controller.ps1
- [x] 2. Add `context` and `gpu_layers` to Get-RuntimeStatus instance serialization (IDictionary block)
- [x] 3. Add `context` and `gpu_layers` to Get-RuntimeStatus instance serialization (foreach array block)
- [x] 4. Fix slider max to use metadata contextLength instead of runtime context
- [x] 5. Update UI display to show `current / max` format
- [x] 6. Restart controller and verify slider behavior

**Next step for user:** Restart the PowerShell controller so the `/status` endpoint exposes `context` / `gpu_layers`. Rebuild/reload the model-manager UI (`npm run build` or Vite dev server restart) to pick up the `App.jsx` changes.

