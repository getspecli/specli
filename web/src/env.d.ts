declare module 'swagger-ui-dist/swagger-ui-es-bundle.js' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const SwaggerUIBundle: (config: Record<string, unknown>) => any;
  export default SwaggerUIBundle;
}
declare module 'swagger-ui-dist/swagger-ui.css';
declare module '*.css';
declare module '*?url' {
  const url: string;
  export default url;
}
declare module '@plantuml/core' {
  export function renderToString(lines: string[], ok: (svg: string) => void, err: (msg: string) => void): void;
}
