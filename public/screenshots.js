window.Screenshots = (function () {
  const getters = {};
  const resetters = {};

  function resizeImage(file, maxDim, quality) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          let { width, height } = img;
          if (width > maxDim || height > maxDim) {
            const scale = maxDim / Math.max(width, height);
            width = Math.round(width * scale);
            height = Math.round(height * scale);
          }
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          canvas.getContext("2d").drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL("image/jpeg", quality));
        };
        img.onerror = reject;
        img.src = e.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function mount(container, storageKey, slotCount) {
    slotCount = slotCount || 8;
    let items = [];
    try {
      items = JSON.parse(localStorage.getItem(storageKey) || "[]");
    } catch {
      items = [];
    }
    while (items.length < slotCount) items.push(null);

    function persist() {
      try {
        localStorage.setItem(storageKey, JSON.stringify(items));
      } catch {
        // localStorage quota exceeded — the image just won't survive a reload.
      }
    }

    async function handleFile(i, file) {
      if (!file) return;
      try {
        items[i] = await resizeImage(file, 1024, 0.82);
        persist();
        render();
      } catch {
        alert("Could not load that image");
      }
    }

    function render() {
      container.innerHTML = items
        .map(
          (dataUrl, i) => `
        <div class="screenshot-slot">
          <input type="file" accept="image/*" class="screenshot-input" id="${storageKey}-slot-${i}">
          <label for="${storageKey}-slot-${i}" class="screenshot-preview ${dataUrl ? "" : "empty"}">
            ${dataUrl ? `<img src="${dataUrl}">` : "<span>+ Add</span>"}
          </label>
          ${dataUrl ? `<button type="button" class="screenshot-remove" data-index="${i}">×</button>` : ""}
        </div>`
        )
        .join("");

      container.querySelectorAll(".screenshot-input").forEach((input, i) => {
        input.addEventListener("change", () => handleFile(i, input.files[0]));
      });

      container.querySelectorAll(".screenshot-preview").forEach((label, i) => {
        label.addEventListener("dragover", (e) => {
          e.preventDefault();
          label.classList.add("drag-over");
        });
        label.addEventListener("dragleave", () => {
          label.classList.remove("drag-over");
        });
        label.addEventListener("drop", (e) => {
          e.preventDefault();
          label.classList.remove("drag-over");
          handleFile(i, e.dataTransfer.files && e.dataTransfer.files[0]);
        });
      });

      container.querySelectorAll(".screenshot-remove").forEach((btn) => {
        btn.addEventListener("click", () => {
          items[Number(btn.dataset.index)] = null;
          persist();
          render();
        });
      });
    }

    render();

    getters[storageKey] = () =>
      items
        .filter(Boolean)
        .map((dataUrl) => {
          const m = /^data:(.+);base64,(.*)$/.exec(dataUrl);
          return m ? { mediaType: m[1], base64: m[2] } : null;
        })
        .filter(Boolean);

    resetters[storageKey] = () => {
      for (let i = 0; i < items.length; i++) items[i] = null;
      persist();
      render();
    };
  }

  function getAll(storageKey) {
    return getters[storageKey] ? getters[storageKey]() : [];
  }

  function resetAll(storageKey) {
    if (resetters[storageKey]) resetters[storageKey]();
  }

  return { mount, getAll, resetAll };
})();
