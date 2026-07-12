const { createApp, h } = window.Vue || {};

if (createApp && window.ElementPlus) {
  const app = createApp({
    name: "SyncinemaVueShell",
    render() {
      return h(
        window.ElementPlus.ElConfigProvider,
        {
          namespace: "el",
          size: "default",
          zIndex: 3000
        },
        {
          default: () => h("div", { class: "vue-shell-sentinel", "aria-hidden": "true" })
        }
      );
    }
  });

  app.use(window.ElementPlus);
  app.mount("#vueEnhanceMount");
  document.documentElement.dataset.uiFramework = "vue3-element-plus";
}
