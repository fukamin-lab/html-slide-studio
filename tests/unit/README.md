# Unit tests

Node's built-in test runner covers the remaining pure editor helpers, same-file overwrite/asset lifecycle, crash recovery, and the second-instance launch gate used while a save is active.

```powershell
npm run test:unit
```

DOM-dependent slide mutation, overlay rehydration, overwrite-save, reopen, and presentation entry are covered by `npm run e2e:smoke` against the built Electron app.
