window.addEventListener("SYAKEN_AUTO_CALL", (event) => {
  const detail = event.detail || {};
  if (detail.command === "submitform" && typeof submitform === "function") {
    submitform();
    return;
  }

  if (detail.command === "form1Submit" && document.form1) {
    document.form1.submit();
  }
});
