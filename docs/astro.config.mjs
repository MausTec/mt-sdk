import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  integrations: [
    starlight({
      title: "Maus-Tec Plugin SDK",
      logo: {
        src: "./src/assets/logo.svg",
        replacesTitle: false,
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/maustec/mt-sdk",
        },
      ],
      customCss: ["./src/styles/custom.css"],
      sidebar: [
        {
          label: "Guides",
          autogenerate: { directory: "guides" },
        },
        {
          label: "Language Reference",
          autogenerate: { directory: "reference/language" },
        },
        {
          label: "Builtin API",
          autogenerate: { directory: "reference/builtins" },
        },
        {
          label: "Device API",
          autogenerate: { directory: "reference/devices", collapsed: true },
        },
      ],
      editLink: {
        baseUrl: "https://github.com/maustec/mt-sdk/edit/main/docs/",
      },
    }),
  ],
});
