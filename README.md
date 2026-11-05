# Brainrot Buddy

A website blocker for Chromium browsers (Microsoft Edge, Chrome). Extra time on a blocked site needs a **signed approval from a partner you choose**. It is a friction tool, not security: you can always uninstall it.

- No accounts, no server, no database, no analytics.
- **The extension sends nothing anywhere.** It makes no network requests. Your lists, time used and settings stay in your browser.
- The extension has **no built-in address** for the companion page. You enter the one you want to use: a hosted copy or your own.

Hosted setup guide and privacy policy: https://brainrot-buddy.netlify.app/guide and https://brainrot-buddy.netlify.app/privacy

## How it works

| Part | What it is | Network |
|---|---|---|
| `extension/` | Manifest V3 extension. Holds lists, counts time, blocks sites, checks approvals. | None. |
| `companion/` | Static web page (HTML, CSS, JS) your partner opens to pair and approve. | None after load. Its Content-Security-Policy has `connect-src 'none'`. |
| You and your partner | Send each other two links in any chat. | Whatever chat you use. |

1. **Pairing (once).** The partner opens the companion page at `/#setup` and chooses a PIN (6+ characters). The page derives an Ed25519 key pair from it (PBKDF2-SHA256, 1,000,000 iterations, WebCrypto) and shows the **public key** as a pairing code. The partner sends it to you and you paste it into the extension. The extension stores only the public key.
2. **Lock in.** From then on, changes that weaken blocking (removing a site or list, raising a budget, turning off adult blocking, changing the partner) need a signed approval. Making blocking stricter stays free.
3. **Request.** On a blocked page, "Request time" creates a request (id, action, site, minutes, note) and copies a link `https://<companion>/#r=…` to the clipboard.
4. **Approval.** The partner opens the link, sees the site and note, types the PIN and approves. The page signs the request and shows `https://<companion>/#a=<id>.<minutes>.<signature>`.
5. **Redemption.** You open the approval link on your computer. The extension sees the navigation to the companion address you entered, reads the fragment, checks that the id matches your pending request and that the signature verifies against the stored public key, then grants that one site for the approved minutes. Each approval works once and expires after 60 minutes.

All request and approval data is in the URL fragment (`#…`). Browsers do not send fragments to servers, so the host of the companion page never receives it.

## Install the extension

- From the Microsoft Edge Add-ons store, or
- From source: open `edge://extensions` (or `chrome://extensions`), turn on Developer mode, click **Load unpacked** and choose the `extension/` folder. The settings page opens on install; click the toolbar icon to reopen it.

### Permissions

| Permission | Why |
|---|---|
| Access to all sites and a content script on http(s) pages | Any site can be put on a list. The content script only draws a small countdown timer (`extension/content/timer.js`) and reads nothing from the page. |
| `webNavigation` | See that a page is about to open so it can be blocked, and notice the approval link being opened. |
| `tabs` | Redirect a blocked tab and know which tab is active, so time is counted only while a listed site is visible. |
| `storage` | Keep settings and usage on the device. |
| `alarms` | Count time and end approvals on schedule while the service worker is suspended. |

There is no remote code and no `eval`. The only `fetch` loads `extension/data/adult-domains.json`, which ships inside the package.

## Host the companion page yourself

Only the `companion/` folder goes online. It is static: no build step, no server logic.

1. Upload the `companion/` folder to any static host that serves **HTTPS** (GitHub Pages, Netlify Drop, Cloudflare Pages, …).
2. Open the address and check that `/#setup` shows the partner setup page.
3. In the extension's **Partner** tab, enter that address.

Choose the address **before locking in**. It is fixed at lock-in, because the companion site is exempt from blocking and changing it afterwards would be a bypass.

The partner needs a recent browser (Chrome 137+, Safari 17+, Firefox 129+), because the page uses Ed25519 in WebCrypto.

## Adult-content list

`extension/data/adult-domains.json` is a JSON array of lowercase domains, loaded by the background worker. The list shipped here is a short seed list. Replace it with a larger one if you want; check that the list's licence allows redistribution.

## Known limits

Disabling or uninstalling the extension, private windows (unless allowed), another browser or device, editing extension storage in DevTools, and changing the system clock all bypass the block. That is the intended escape hatch.

## Licence

No licence has been chosen yet. Add a `LICENSE` file before sharing this publicly.
