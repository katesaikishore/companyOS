# Windows signing

**Status:** Draft, 2026-10-31. The build can sign the Windows installer, but no certificate exists yet, so no signed build has been made. Signing is blocked on a certificate and a publisher identity, which only the owner can obtain (section 6). Plan references: section 9 (packaging) and section 13, question 8.

This guide covers how the Windows installer is signed, which variables the build reads, what it does without a certificate, and what the owner must do. It contains no secrets, keys or account values. Secret values go only in the CI secret store.

## 1. Where things stand

| Piece | File | State |
|---|---|---|
| Windows target | [`apps/desktop/electron-builder.yml`](../../apps/desktop/electron-builder.yml), `win` block | NSIS installer (`nsis`), with `signAndEditExecutable: true` |
| Signing notes | `electron-builder.yml`, comment lines 22 to 30 | Names `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`. Says Azure Artifact Signing "is not configured yet". |
| Local builds | [`apps/desktop/scripts/package.mjs`](../../apps/desktop/scripts/package.mjs) | Turns off certificate auto-discovery unless a signing variable is set |
| Release CI | [`.github/workflows/release.yml`](../../.github/workflows/release.yml), Windows step | Passes `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` from secrets. Builds unsigned when the first is empty. |
| Post-build check | `package.mjs` | Checks macOS only. Nothing checks the Windows signature. |
| Maintainer notes | [`docs-site/releasing.mdx`](../../docs-site/releasing.mdx), Windows section | Says installers stay unsigned until the two variables are set |

The build uses electron-builder 26.18.0, the version installed in `node_modules`.

## 2. Choose a certificate route (plan section 9)

The plan allows two routes. Both need a publicly trusted code-signing certificate whose private key is held on a hardware security module (HSM). The research notes in [`docs/research/os-capture.md`](../research/os-capture.md) record three constraints: publicly trusted code-signing certificates are capped at 460 days from 2026-03-01, SmartScreen reputation builds per file, and an EV certificate no longer gives instant reputation.

### Route A: Azure Artifact Signing (formerly Trusted Signing)

- The keys stay in Azure. CI needs only Azure sign-in, and no key file.
- The research notes give a price of $9.99 a month for 5,000 signatures. Confirm the current price.
- Eligibility is the open question. The notes say onboarding is limited by geography and company history, and that individuals and non-US organisations are reportedly excluded. That claim is unverified, and one source for it is an AI-generated answer. Check Microsoft's current requirements before buying.
- Build support exists. electron-builder 26.18.0 reads an `azureSignOptions` block and signs through the `TrustedSigning` PowerShell module (`Invoke-TrustedSigning`). The block needs `endpoint`, `certificateProfileName`, `codeSigningAccountName` and `publisherName`. The repo does not set it yet, so adding it is a code change that needs the account values first.
- The Windows runner must install that PowerShell module from the PowerShell Gallery and be signed in to Azure.

### Route B: OV certificate on a cloud HSM

- Buy an OV code-signing certificate from a certificate authority (CA) that keeps the key on a cloud HSM.
- In most cases the key cannot be exported as a PFX file, so the `WIN_CSC_LINK` file route does not apply. Ask the CA for its signing client, then use one of these:
  - Set `win.signtoolOptions.sign` to a script that calls the CA's client. electron-builder calls this function for each file it signs.
  - Install the certificate in the Windows certificate store on the runner, and select it with `signtoolOptions.certificateSha1` or `certificateSubjectName`.
- A certificate lasts at most 460 days, so it must be bought again about every 15 months.

Route A is less work if the company is eligible. Otherwise Route B is the choice. The owner makes this decision and records it in the plan's decision log.

## 3. Environment variables the build reads

| Name | Where it is set | What it does |
|---|---|---|
| `WIN_CSC_LINK` | CI secret, or local environment | Path to a PFX file, or its base64 text. Used by the signtool route (electron-builder's `WIN_CSC_LINK`). |
| `WIN_CSC_KEY_PASSWORD` | CI secret, or local environment | Password of that PFX. Used when `signtoolOptions.certificatePassword` is not set. |
| `CSC_LINK` | macOS only | The macOS certificate. electron-builder also uses it for Windows when `WIN_CSC_LINK` is unset. See the warning in section 4. |
| `CSC_IDENTITY_AUTO_DISCOVERY` | Set to `false` by `package.mjs` and by the release workflow | Stops the build from picking up a certificate that is already on the machine |
| Azure sign-in variables (Route A) | CI secret | The TrustedSigning module signs in through Azure Identity. Azure's environment credential reads `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET`, or an OIDC setup. Confirm the names in Microsoft's documentation before adding them. |
| CA client login (Route B) | CI secret | Named by the CA's client tool. Add it only after the CA is chosen. |

Config values that are not secrets go in `electron-builder.yml`. These are the Azure endpoint, certificate profile name, account name and publisher name, and the signing hash and timestamp servers. electron-builder 26.18.0 defaults to SHA-1 and SHA-256 signing, and to `http://timestamp.digicert.com` for timestamps. Azure signing defaults to `http://timestamp.acs.microsoft.com`.

Signing material is already excluded from git by `.gitignore`. Never commit a certificate, key or password.

## 4. What the build does

### With a certificate set

1. electron-builder signs the app executable, the uninstaller and the NSIS installer, because `signAndEditExecutable` is true.
2. By default each file is signed twice, first with SHA-1 and then with SHA-256. Signing with SHA-256 only is a common choice. Set `signtoolOptions.signingHashAlgorithms` when the certificate is bought.
3. A transient failure (an unresolved host, or a file in use) is retried up to three times.
4. If the certificate cannot be read, the build stops with `Env WIN_CSC_LINK is not correct, cannot resolve`.
5. A signing error fails the build. This comes from reading the electron-builder code. No real signing has been run.

### With no certificate set

- For each file, electron-builder logs `no code signing certificate configured, signing is skipped` and builds an unsigned installer. The build still succeeds.
- The release workflow prints `Signing: no certificate, building unsigned.` and uploads the unsigned `.exe` as an artifact. Nothing fails. Users see SmartScreen warnings, as `docs-site/releasing.mdx` says.
- A local build with `npm run dist -w @companyos/desktop` behaves the same way.

### Gaps to close before the first public release

These are recommendations. None is implemented in this change.

- **No gate on Windows releases.** The macOS build refuses to run without its secrets, but the Windows build does not. A tagged release can ship unsigned with no error.
- **No check of the Windows signature.** `package.mjs` checks macOS only. Add a step that runs `Get-AuthenticodeSignature` and fails unless the status is `Valid` and the signer is the company's legal name.
- **Format mismatch.** Plan section 9 says "Windows: signed MSI". The build produces an NSIS `.exe`. Decide which format ships, then update either the plan or `electron-builder.yml`.
- **The macOS certificate can reach Windows.** electron-builder falls back to `CSC_LINK` when `WIN_CSC_LINK` is unset, and it would try to sign Windows files with the macOS Developer ID certificate. The release workflow does not pass `CSC_LINK` to the Windows step, so CI is safe today. Never export `CSC_LINK` on a Windows build machine.

## 5. Check a signed build

On a Windows machine, after a build with the certificate set:

```powershell
Get-AuthenticodeSignature "apps\desktop\release\*.exe" | Format-List Status, StatusMessage, SignerCertificate, TimeStamperCertificate
```

- `Status` must be `Valid`.
- The subject of `SignerCertificate` must be the company's legal name.
- `TimeStamperCertificate` must be present, so the signature stays valid after the certificate expires.
- On a clean Windows machine, install and launch the build. Windows should show no "unknown publisher" warning. SmartScreen can still warn about a new file until its reputation builds.
- Test an in-app update from one signed build to the next. electron-builder turns on the update signature check by default (`verifyUpdateCodeSignature` is not `false`, in `winPackager.js`), so the test matters.

## 6. What the owner must do

Signing stays blocked until these are done.

1. **Decide the route** (plan section 13, question 8): Route A or Route B, from section 2. Record the decision in the plan.
2. **Confirm eligibility.** For Route A, check Microsoft's current country and company-age rules for Artifact Signing. For Route B, confirm that a CA will issue an OV certificate on a cloud HSM to the company.
3. **Establish the publisher identity.** Windows shows the certificate's name in Properties, Digital Signatures and in the UAC prompt. Prepare the company's legal name as registered, its registered address, and any registration number the CA asks for, such as a D-U-N-S number. Name an authorised contact who can complete identity validation. The sandbox cannot do this.
4. **Buy and validate.** Create the Azure Artifact Signing account and a public-trust certificate profile, or buy the OV certificate and set up its HSM client. Keep the purchase record.
5. **Add secrets in GitHub** (repository settings, then secrets). Route B with a PFX: `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`. Route A: the Azure sign-in secrets. Route B with an HSM: the CA client's login secret. Never paste a value into the repository, a document or a chat.
6. **Send the account values to engineering.** For Route A: endpoint, certificate profile name, account name and publisher name. For Route B: the CA's client tool and the command it runs. These go in `electron-builder.yml`, not in secrets.
7. **Run one signed Windows build** and the checks in section 5.
8. **Set a renewal reminder.** The certificate lasts at most 460 days. Renew it well before it expires.
9. **Decide MSI or NSIS** (section 4).

Once steps 1 to 6 are done, engineering adds the configuration (`azureSignOptions`, or `signtoolOptions.sign` or the store match), adds the Windows gate and signature check, runs a signed build, and updates `docs-site/releasing.mdx` and the signing note in `README.md`.

---

*Checked against electron-builder 26.18.0 source in `node_modules` (`app-builder-lib`: `winPackager.js`, `platformPackager.js`, `codeSign/windowsCodeSign.js`, `codeSign/windowsSignAzureManager.js`, `codeSign/windowsSignToolManager.js`) and the repository files linked above. No build or signing was run.*
