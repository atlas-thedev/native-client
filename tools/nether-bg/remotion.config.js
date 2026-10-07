const { Config } = require('@remotion/cli/config');
// The sandbox has TypeScript 7 (no ts.sys); give the esbuild loader a tsconfig so it never asks typescript.
Config.overrideWebpackConfig((c) => {
  const walk = (rules) => (rules || []).forEach((r) => {
    if (r && r.use) [].concat(r.use).forEach((u) => { if (u && typeof u === 'object' && String(u.loader).includes('esbuild-loader')) u.options = { ...u.options, tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } } }; });
    if (r && r.oneOf) walk(r.oneOf);
  });
  walk(c.module && c.module.rules);
  return c;
});
