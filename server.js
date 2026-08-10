const app = require("./lib/app");

const PORT = process.env.PORT || 3210;
app.listen(PORT, () => {
  console.log(`DooPresta running at http://localhost:${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
});
