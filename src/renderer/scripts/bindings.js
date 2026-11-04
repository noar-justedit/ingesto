// ═══════════════════════════════════════════════════════
// What the controls of index.html do
// ═══════════════════════════════════════════════════════
// Every event handler of the markup, bound here rather than written in an
// onclick="..." attribute: index.html holds no code, and the window can run
// under a policy that refuses inline script. A control is found by its id,
// or by its data-js name when it has no id.
//
// Each handler is a plain function: inside it, `this` is the control and
// `event` the event, as they were in the attribute. It is set as the control's
// onclick / onchange / ... property, the very slot the attribute filled: it
// runs at the same moment, and code that later sets that property replaces it
// as it replaced the attribute.
//
// The controls drawn later by the code (source cards, template chips, presets,
// summaries...) get their handlers where they are drawn.
function on(selector, type, handler) {
  const els = document.querySelectorAll(selector);
  if (!els.length) console.error('bindings.js: nothing matches ' + selector);
  for (const el of els) el['on' + type] = handler;
}

on('#fb-kiosk', 'click', function (event) { enterKiosk(); });
on('#fb-verify', 'click', function (event) { startVerifyFolder(); });
on('#fb-settings', 'click', function (event) { openSettings(); });
on('#btn-min', 'click', function (event) { window.ingesto.winMinimize(); });
on('#btn-max', 'click', function (event) { window.ingesto.winMaximize(); });
on('#btn-close', 'click', function (event) { window.ingesto.winClose(); });
on('[data-js="src-scroll"]', 'dragover', function (event) { onDZ(event,'src'); });
on('[data-js="src-scroll"]', 'drop', function (event) { dropDZ(event,'src'); });
on('#src-zone', 'dragover', function (event) { onDZ(event,'src'); });
on('#src-zone', 'dragleave', function (event) { offDZ(event,'src'); });
on('#src-zone', 'drop', function (event) { dropDZ(event,'src'); });
on('[data-js="browse-folder-src"]', 'click', function (event) { browseFolder('src'); });
on('[data-js="clear-copy-info-cards"]', 'click', function (event) { clearCopyInfo(); });
on('[data-js="clear-copy-info-global"]', 'click', function (event) { clearCopyInfo(); });
on('#meta-cam', 'input', function (event) { sanitizeMeta(this);persistPrefs();syncDefaultsToSources(); });
on('#meta-model', 'input', function (event) { sanitizeMeta(this);persistPrefs();syncDefaultsToSources(); });
on('#meta-pp', 'input', function (event) { sanitizePP(this);persistPrefs();syncDefaultsToSources(); });
on('#meta-note', 'input', function (event) { persistPrefs();syncDefaultsToSources(); });
on('[data-js="show-counter-info"]', 'click', function (event) { showCounterInfo(); });
on('[data-js="counter-minus"]', 'click', function (event) { stepCounter(-1); });
on('#counter-input', 'input', function (event) { onCounterInput(); });
on('#counter-input', 'blur', function (event) { renderCounter(); });
on('[data-js="counter-plus"]', 'click', function (event) { stepCounter(1); });
on('#counter-auto-btn', 'click', function (event) { resetCounterOverride(); });
on('[data-js="open-je"]', 'click', function (event) { openJE(); });
on('#fb-system', 'click', function (event) { toggleFilter('system'); });
on('#fb-network', 'click', function (event) { toggleFilter('network'); });
on('#fb-showhidden', 'click', function (event) { toggleShowHidden(); });
on('#refresh-btn', 'click', function (event) { loadVolumes(true); });
on('#sess-clear', 'click', function (event) { clearIngestHistory(); });
on('#sess-open', 'click', function (event) { openReport(); });
on('[data-js="show-modes-info"]', 'click', function (event) { showModesInfo(); });
on('#mode-fast', 'click', function (event) { setMode('fast'); });
on('#mode-normal', 'click', function (event) { setMode('normal'); });
on('#mode-slow', 'click', function (event) { setMode('slow'); });
on('#mode-pro', 'click', function (event) { onSelectPro(); });
on('#pro-dr-toggle', 'change', function (event) { setProDouble(this.checked); });
on('[data-js="show-dr-info"]', 'click', function (event) { showDrInfo(); });
on('[data-js="algo-xxh64"]', 'change', function (event) { algoSwitch(this); });
on('[data-js="algo-xxh128"]', 'change', function (event) { algoSwitch(this); });
on('[data-js="algo-md5"]', 'change', function (event) { algoSwitch(this); });
on('[data-js="dst-scroll"]', 'dragover', function (event) { onDZ(event,'dst'); });
on('[data-js="dst-scroll"]', 'drop', function (event) { dropDZ(event,'dst'); });
on('#dst-zone', 'dragover', function (event) { onDZ(event,'dst'); });
on('#dst-zone', 'dragleave', function (event) { offDZ(event,'dst'); });
on('#dst-zone', 'drop', function (event) { dropDZ(event,'dst'); });
on('[data-js="browse-folder-dst"]', 'click', function (event) { browseFolder('dst'); });
on('#ins-btn', 'click', function (event) { toggleInsertMenu(event); });
on('[data-js="ins-pick-var-counter"]', 'click', function (event) { insPick('var','counter'); });
on('[data-js="ins-pick-var-cardname"]', 'click', function (event) { insPick('var','cardname'); });
on('[data-js="ins-pick-var-camera"]', 'click', function (event) { insPick('var','camera'); });
on('[data-js="ins-pick-var-pp"]', 'click', function (event) { insPick('var','pp'); });
on('[data-js="ins-pick-var-operator"]', 'click', function (event) { insPick('var','operator'); });
on('[data-js="ins-pick-txt"]', 'click', function (event) { insPick('txt'); });
on('[data-js="ins-pick-sep-underscore"]', 'click', function (event) { insPick('sep','_'); });
on('[data-js="ins-pick-sep-hyphen"]', 'click', function (event) { insPick('sep','-'); });
on('[data-js="ins-pick-var-yy"]', 'click', function (event) { insPick('var','YY'); });
on('[data-js="ins-pick-var-yyyy"]', 'click', function (event) { insPick('var','YYYY'); });
on('[data-js="ins-pick-var-mm"]', 'click', function (event) { insPick('var','MM'); });
on('[data-js="ins-pick-var-dd"]', 'click', function (event) { insPick('var','DD'); });
on('[data-js="ins-pick-var-hh"]', 'click', function (event) { insPick('var','HH'); });
on('[data-js="ins-pick-var-min"]', 'click', function (event) { insPick('var','MIN'); });
on('[data-js="add-tok-sep"]', 'click', function (event) { addTok('sep','/'); });
on('#tpl-box', 'dblclick', function (event) { showRawTemplate(); });
on('#tpl-box', 'dragover', function (event) { tokContainerOver(event); });
on('#tpl-box', 'drop', function (event) { tokContainerDrop(event); });
on('#tpl-raw', 'input', function (event) { onRawInput(); });
on('#tpl-raw', 'focus', function (event) { rawFocused=true; });
on('#tpl-raw', 'blur', function (event) { rawFocused=false;hideRawTemplate(); });
on('[data-js="save-template-quick"]', 'click', function (event) { saveTemplateQuick(); });
on('[data-js="export-presets"]', 'click', function (event) { exportPresets(); });
on('[data-js="import-presets"]', 'click', function (event) { importPresets(); });
on('#pause-btn', 'click', function (event) { onPauseBtn(); });
on('#start-btn', 'click', function (event) { onStartBtn(); });
on('#sum-recopy', 'click', function (event) { recopyFailed(); });
on('#sum-close', 'click', function (event) { closeSummary(); });
on('[data-js="sno-cancel"]', 'click', function (event) { snoCancel(); });
on('[data-js="sno-confirm"]', 'click', function (event) { snoConfirm(); });
on('#ctx-load', 'click', function (event) { ctxLoad(event); });
on('#ctx-save', 'click', function (event) { ctxSave(event); });
on('#ctx-del', 'click', function (event) { ctxDelete(event); });
on('#modes-info-ov', 'click', function (event) { if(event.target===this)hideModesInfo(); });
on('[data-js="hide-modes-info"]', 'click', function (event) { hideModesInfo(); });
on('#dr-info-ov', 'click', function (event) { if(event.target===this)hideDrInfo(); });
on('[data-js="hide-dr-info"]', 'click', function (event) { hideDrInfo(); });
on('#counter-info-ov', 'click', function (event) { if(event.target===this)hideCounterInfo(); });
on('[data-js="set-counter-width-2"]', 'click', function (event) { setCounterWidth(2); });
on('[data-js="set-counter-width-3"]', 'click', function (event) { setCounterWidth(3); });
on('[data-js="set-counter-width-4"]', 'click', function (event) { setCounterWidth(4); });
on('[data-js="hide-counter-info"]', 'click', function (event) { hideCounterInfo(); });
on('#pro-warn-ov', 'click', function (event) { if(event.target===this)proWarnCancel(); });
on('[data-js="pro-warn-cancel"]', 'click', function (event) { proWarnCancel(); });
on('[data-js="pro-warn-use"]', 'click', function (event) { proWarnUse(); });
on('[data-js="kiosk-request-admin"]', 'click', function (event) { kioskRequestAdmin(); });
on('#k-op', 'input', function (event) { sanitizeMeta(this);kioskUpdateStart(); });
on('#k-cam', 'input', function (event) { sanitizeMeta(this);kioskCamTyped(); });
on('#k-pp', 'input', function (event) { sanitizePP(this); });
on('#k-start', 'click', function (event) { kioskStart(); });
on('[data-js="kiosk-pin-key-1"]', 'click', function (event) { kioskPinKey('1'); });
on('[data-js="kiosk-pin-key-2"]', 'click', function (event) { kioskPinKey('2'); });
on('[data-js="kiosk-pin-key-3"]', 'click', function (event) { kioskPinKey('3'); });
on('[data-js="kiosk-pin-key-4"]', 'click', function (event) { kioskPinKey('4'); });
on('[data-js="kiosk-pin-key-5"]', 'click', function (event) { kioskPinKey('5'); });
on('[data-js="kiosk-pin-key-6"]', 'click', function (event) { kioskPinKey('6'); });
on('[data-js="kiosk-pin-key-7"]', 'click', function (event) { kioskPinKey('7'); });
on('[data-js="kiosk-pin-key-8"]', 'click', function (event) { kioskPinKey('8'); });
on('[data-js="kiosk-pin-key-9"]', 'click', function (event) { kioskPinKey('9'); });
on('[data-js="kiosk-pin-cancel"]', 'click', function (event) { kioskPinCancel(); });
on('[data-js="kiosk-pin-key-0"]', 'click', function (event) { kioskPinKey('0'); });
on('[data-js="kiosk-pin-del"]', 'click', function (event) { kioskPinDel(); });
on('#kr-btn', 'click', function (event) { kioskReset(); });
on('#krun-cancel', 'click', function (event) { kioskCancelCopy(); });
on('[data-js="cancel-verify-folder"]', 'click', function (event) { cancelVerifyFolder(); });
on('[data-js="close-verify-result"]', 'click', function (event) { closeVerifyResult(); });
on('#settings-ov', 'click', function (event) { if(event.target===this)closeSettings(); });
on('#sentinel-toggle', 'change', function (event) { onSentinelToggle(this); });
on('#cksum-toggle', 'change', function (event) { onChecksumToggle(this); });
on('#cf-list', 'change', function (event) { onChecksumFmt(); });
on('#cf-mhl', 'change', function (event) { onChecksumFmt(); });
on('#cf-ascmhl', 'change', function (event) { onChecksumFmt(); });
on('#report-toggle', 'change', function (event) { onReportToggle(this); });
on('[data-js="open-report"]', 'click', function (event) { openReport(); });
on('#rf-html', 'change', function (event) { onReportFmt(); });
on('#rf-csv', 'change', function (event) { onReportFmt(); });
on('#rf-json', 'change', function (event) { onReportFmt(); });
on('#rf-full', 'change', function (event) { onReportDetail(this); });
on('#filefilter-toggle', 'change', function (event) { onFileFilterToggle(this); });
on('#ff-empty', 'change', function (event) { onFilterOpt('copyEmptyFolders',this.checked); });
on('#ff-reorg', 'change', function (event) { onFilterOpt('reorganizeFiles',this.checked); });
on('#set-ntfy-en', 'change', function (event) { onNtfyToggle(this); });
on('#set-ntfy-server', 'input', function (event) { onNtfyField(); });
on('#set-ntfy-topic', 'input', function (event) { onNtfyField(); });
// This link sits in a paragraph that the translation replaces as a whole
// (i18n.js, blocks), which draws the link again: it is listened to from the
// document, so that the link drawn by the translation works too.
document.addEventListener('click', function (event) {
  if (event.target.closest && event.target.closest('[data-js="open-ntfy-site"]')) openNtfySite();
});
on('[data-js="test-ntfy"]', 'click', function (event) { testNtfy(); });
on('#set-hook-en', 'change', function (event) { onHookToggle(this); });
on('#set-hook', 'input', function (event) { onHookField(); });
on('#set-handoff-en', 'change', function (event) { onHandoffToggle(this); });
on('#set-handoff', 'input', function (event) { onHandoffField(); });
on('[data-js="handoff-dry-run"]', 'click', function (event) { handoffDryRun(); });
on('#sx-tpl', 'change', function (event) { onExportInc(); });
on('#sx-presets', 'change', function (event) { onExportInc(); });
on('#sx-mode', 'change', function (event) { onExportInc(); });
on('#sx-track', 'change', function (event) { onExportInc(); });
on('#sx-cksum', 'change', function (event) { onExportInc(); });
on('#sx-report', 'change', function (event) { onExportInc(); });
on('#sx-filter', 'change', function (event) { onExportInc(); });
on('[data-js="export-settings-file"]', 'click', function (event) { exportSettingsFile(); });
on('[data-js="import-settings-file"]', 'click', function (event) { importSettingsFile(); });
on('[data-js="close-settings"]', 'click', function (event) { closeSettings(); });
