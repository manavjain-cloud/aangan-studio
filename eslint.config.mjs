import next from "eslint-config-next";

const config = [
  ...next,
  { ignores: [".next/**", "_extracted/**", "drizzle/**", "node_modules/**", "coverage/**"] },
  {
    rules: {
      "react-hooks/set-state-in-effect": "off",
    },
  },
];

export default config;
