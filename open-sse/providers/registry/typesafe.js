export default {
  id: "typesafe",
  priority: 5,
  alias: "typesafe",
  display: {
    name: "Typesafe",
    icon: "psychology",
    color: "#E551BA",
    textIcon: "TS",
    website: "https://www.typesafe.ai",
    notice: {
      text: "TypeSafe — the original System One decision API. Jev turns state + questions into typed answers and calibrated probabilities. API key from the console.",
      apiKeyUrl: "https://console.typesafe.ai",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  models: [
    { id: "jev-latest", name: "Jev Latest (Stable)", kind: "systemone" },
    { id: "jev-preview", name: "Jev Preview", kind: "systemone" },
    { id: "jev-1.14.0", name: "Jev 1.14.0", kind: "systemone" },
    { id: "jev-1.13.0", name: "Jev 1.13.0", kind: "systemone" },
  ],
  serviceKinds: ["systemone"],
  systemoneConfig: {
    baseUrl: "https://api.typesafe.ai/v1/systemone",
    authType: "apikey",
    authHeader: "bearer",
  },
};
