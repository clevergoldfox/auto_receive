/* Crowdworks Auto Bid — content script (runs on crowdworks.jp)
 *
 * Flow, once background.js opens a job page on this tab:
 *   1. Project details page  -> click the "応募画面へ" button to open the form.
 *   2. Application form       -> enter the quote (price) + the application text,
 *                                then click the "応募する" button.
 *   3. Report completion; background.js then closes the tab.
 *
 * If the form cannot be located, the script dumps the page's inputs / buttons
 * into the extension activity log (via "cw-log") so the heuristics below can be
 * corrected. Crowdworks' DOM differs by job type and changes over time.
 */
(function () {
  'use strict';

  // Visible text on the button that opens the application form (step 1).
  const APPLY_TEXT = ['応募画面へ', '応募画面へ進む', '応募画面'];
  // Visible text on the final submit button of the application form (step 2).
  const SUBMIT_TEXT = ['応募する', 'この内容で応募', '応募を確定'];
  // Keywords identifying the quote / amount input.
  const AMOUNT_KW = /amount|price|budget|reward|金額|単価|報酬|予算|見積/i;

  const MAX_TICKS = 16; // ~32s of retries per page

  /* ----------------------------- helpers ------------------------------ */

  const isVisible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  };

  const buttonByText = (texts) => {
    const els = [
      ...document.querySelectorAll('button, a, input[type="submit"], input[type="button"]'),
    ].filter(isVisible);
    for (const t of texts) {
      const hit = els.find((e) => (e.innerText || e.value || '').trim().includes(t));
      if (hit) return hit;
    }
    return null;
  };

  // Finds the quote/amount input: by attributes, then by label text, then by
  // falling back to the first number input.
  function findAmountInput() {
    const inputs = [...document.querySelectorAll('input')]
      .filter(isVisible)
      .filter((i) => ['text', 'number', 'tel', ''].includes((i.type || '').toLowerCase()));
    let hit = inputs.find((i) =>
      AMOUNT_KW.test(`${i.name} ${i.id} ${i.placeholder} ${i.getAttribute('aria-label') || ''}`));
    if (hit) return hit;
    hit = inputs.find((i) => i.labels && i.labels[0] && AMOUNT_KW.test(i.labels[0].innerText || ''));
    if (hit) return hit;
    return inputs.find((i) => (i.type || '').toLowerCase() === 'number') || null;
  }

  // The largest visible textarea is taken as the application-text field.
  function findMessageArea() {
    return [...document.querySelectorAll('textarea')]
      .filter(isVisible)
      .sort((a, b) => b.offsetWidth * b.offsetHeight - a.offsetWidth * a.offsetHeight)[0] || null;
  }

  // React-friendly value setter (dispatches input/change so frameworks notice).
  const setValue = (el, value) => {
    const proto = el.tagName === 'TEXTAREA'
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const cwLog = (msg, level) =>
    chrome.runtime.sendMessage({ type: 'cw-log', msg, level }).catch(() => {});
  const report = (ok, extra) =>
    chrome.runtime.sendMessage({ type: 'cw-bid-done', ok, ...extra }).catch(() => {});

  // Dumps the page's form-relevant elements into the activity log.
  function describePage() {
    const label = (el) =>
      el.getAttribute('name') || el.id || el.getAttribute('placeholder') ||
      el.getAttribute('aria-label') || '?';
    const tas = [...document.querySelectorAll('textarea')].filter(isVisible).map(label);
    const ins = [...document.querySelectorAll('input')].filter(isVisible)
      .map((i) => `${i.type}:${label(i)}`);
    const btns = [...document.querySelectorAll('button, input[type=submit], input[type=button], a')]
      .filter(isVisible)
      .map((e) => (e.innerText || e.value || '').trim())
      .filter((t) => t && t.length < 30)
      .slice(0, 30);
    cwLog(`DIAG url: ${location.href}`, 'warn');
    cwLog(`DIAG textareas (${tas.length}): ${tas.join(' | ') || 'none'}`, 'warn');
    cwLog(`DIAG inputs (${ins.length}): ${ins.join(' | ') || 'none'}`, 'warn');
    cwLog(`DIAG buttons/links: ${btns.join(' / ') || 'none'}`, 'warn');
  }

  const isLoginWall = () =>
    !!document.querySelector('input[type=password]') || /\/login|sign_in/.test(location.href);

  /* ------------------------------ logic ------------------------------- */

  let task = null;
  let ticks = 0;

  // Step 2: fill the application form and submit it.
  function tryFillForm() {
    const amount = findAmountInput();
    const message = findMessageArea();
    if (!amount || !message) return false;

    setValue(amount, String(task.price));
    setValue(message, task.message);
    cwLog(`Form found — quote field "${amount.name || amount.id || '?'}" = ${task.price}, ` +
          `text field "${message.name || message.id || '?'}" filled.`);

    const submit =
      buttonByText(SUBMIT_TEXT) ||
      document.querySelector('input[type=submit], button[type=submit]');

    if (!task.autoSubmit) {
      report(true, { filledOnly: true }); // filled only — user reviews & submits
      return true;
    }
    if (!submit) {
      cwLog('Fields filled but the "応募する" button was not found.', 'warn');
      describePage();
      report(false, { error: 'Submit button "応募する" not found.' });
      return true;
    }
    setTimeout(() => {
      cwLog('Clicking "応募する" to submit the bid.');
      submit.click();
      // Success is confirmed when the confirmation page (proposal_ref=create)
      // loads — reporting here would be cancelled by that navigation.
    }, 800);
    // Fallback: if no confirmation page appears, treat the submit as failed.
    setTimeout(() => {
      if (/proposal_ref=create/.test(location.search)) return; // navigated OK
      cwLog('No confirmation page after submit — the bid may have failed.', 'warn');
      describePage();
      report(false, { error: 'No confirmation page appeared after clicking 応募する.' });
    }, 13000);
    return true;
  }

  function tick() {
    ticks++;

    if (isLoginWall()) {
      report(false, { error: 'Not logged in to Crowdworks (login page detected).' });
      return;
    }
    if (tryFillForm()) return;

    if (ticks >= MAX_TICKS) {
      cwLog('Could not locate the application form — dumping page contents:', 'warn');
      describePage();
      report(false, { error: 'Could not locate the application form.' });
      return;
    }

    // Step 1: click "応募画面へ" once per page (tracked per URL path).
    const pathKey = 'cw-applied:' + location.pathname;
    if (!sessionStorage.getItem(pathKey)) {
      const apply = buttonByText(APPLY_TEXT);
      if (apply) {
        sessionStorage.setItem(pathKey, '1');
        cwLog(`Clicking "${(apply.innerText || apply.value || '').trim()}" to open the form.`);
        apply.click();          // may navigate to the form, or reveal it in place
        setTimeout(tick, 3000);
        return;
      }
    }
    setTimeout(tick, 2000);     // form not rendered yet — wait for dynamic content
  }

  function run() {
    chrome.runtime.sendMessage({ type: 'cw-get-task' }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.task) return; // not our tab
      task = resp.task;

      // Post-submit confirmation page — the bid was placed successfully.
      if (/\/proposals\/\d+/.test(location.pathname) &&
          /proposal_ref=create/.test(location.search)) {
        cwLog('Application submitted — confirmation page detected.');
        report(true, { filledOnly: false });
        return;
      }

      cwLog(`Bidding started on ${location.href}`);
      tick();
    });
  }

  if (/crowdworks\.jp/.test(location.href)) {
    setTimeout(run, 1800);
  }
})();
