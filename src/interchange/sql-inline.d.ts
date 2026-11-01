declare module "sql.js/dist/sql-wasm-inline.js" {
  import type { SqlJsStatic } from "sql.js";
  export default function initSqlJs(): Promise<SqlJsStatic>;
}
