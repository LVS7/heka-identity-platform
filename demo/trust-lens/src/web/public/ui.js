/*
 * UI helpers shared by the Trust Lens and the TrustCo Console.
 *
 * Both pages are static, dependency-free files (one vendored QR encoder), so this is a plain
 * script that sets a global rather than a module: the console loads it through the Trust Lens's
 * `/shared` mount and must not need a bundler to do so.
 */

window.ui = (() => {
  const el = (id) => document.getElementById(id)

  const escapeHtml = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    )

  /** SVG QR of `text` into `target`. Requires vendor/qrcode-generator.js to be loaded first. */
  function renderQr(target, text) {
    const qr = qrcode(0, 'M')
    qr.addData(text)
    qr.make()
    target.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true })
  }

  const formatWhen = (iso) => new Date(iso).toLocaleTimeString()

  /**
   * The wallet-link widget in the header: a chip, the DID input, Link and (optionally) Unlink.
   * Both UIs share the link file, so both render it the same way.
   */
  function renderWalletChip(ids, wallet) {
    const { linked, holderDid, source } = wallet
    const chip = el(ids.chipId)
    chip.className = `badge ${linked ? 'ok' : ''}`
    chip.textContent = linked ? `wallet: linked · ${holderDid.slice(0, 22)}…` : 'wallet: not linked'
    chip.title = linked ? `${holderDid}${source === 'env' ? ' (from HOLDER_PUBLIC_DID)' : ''}` : ''
    el(ids.inputId).hidden = linked
    el(ids.linkId).hidden = linked
    if (ids.unlinkId) el(ids.unlinkId).hidden = !linked
  }

  /** Copy to the clipboard; on http origins the browser may refuse, and the text is selectable anyway. */
  async function copyText(text, button) {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      return
    }
    if (!button) return
    // Kept on the button, not read each time: a second click inside the window would read "Copied".
    button.dataset.label ??= button.textContent
    button.textContent = 'Copied'
    setTimeout(() => {
      button.textContent = button.dataset.label
    }, 1200)
  }

  return { el, escapeHtml, renderQr, formatWhen, renderWalletChip, copyText }
})()
