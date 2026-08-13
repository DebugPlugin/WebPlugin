(function () {
  document.querySelectorAll(".section-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      btn.classList.toggle("open");
      document.getElementById(btn.dataset.target).classList.toggle("open");
    });
  });

  document.querySelectorAll(".notes-textarea").forEach((ta) => {
    const key = ta.dataset.storageKey;
    if (!key) return;
    const saved = localStorage.getItem(key);
    if (saved !== null) ta.value = saved;
    ta.addEventListener("input", () => localStorage.setItem(key, ta.value));
  });

  window.Notes = {
    resetAll() {
      document.querySelectorAll(".notes-textarea").forEach((ta) => {
        const key = ta.dataset.storageKey;
        if (key) localStorage.removeItem(key);
        ta.value = "";
      });
    },
  };
})();
