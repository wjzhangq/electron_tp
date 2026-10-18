// scripts/sign-cli.cjs —— 供 Inno SignTool 调用：node sign-cli.cjs "<file>"
require('./sign-hook.cjs')(process.argv[2]).catch((e) => {
  console.error(e);
  process.exit(1);
});
