// Restricted XML reader for signed bank responses. No DTD, external entities or attributes.
// Preserve sibling order and repeated nested nodes for Freedom Pay's recursive signature.
type XmlNode = { name: string; text: string; children: XmlNode[] };
function decode(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (entity in named) return named[entity];
    return String.fromCodePoint(
      entity.startsWith("#x") ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)),
    );
  });
}
export function readPaymentXml(xml: string): {
  fields: Record<string, string>;
  signatureFields: Record<string, string>;
} {
  if (xml.length > 131072 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("Invalid bank XML");
  const root: XmlNode = { name: "", text: "", children: [] };
  const stack = [root];
  const tokens = xml.match(/<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<[^>]*>|[^<]+/g) ?? [];
  if (tokens.join("") !== xml) throw new Error("Incomplete bank XML");
  for (const token of tokens) {
    const current = stack[stack.length - 1];
    if (token.startsWith("<?xml") && stack.length === 1) continue;
    if (token.startsWith("<![CDATA[")) {
      current.text += token.slice(9, -3);
      continue;
    }
    if (token.startsWith("</")) {
      if (stack.length < 2 || token !== `</${current.name}>`)
        throw new Error("Unbalanced bank XML");
      stack.pop();
      continue;
    }
    if (token.startsWith("<")) {
      const tag = token.match(/^<([a-zA-Z_][a-zA-Z0-9_]*)(\s*\/?)>$/);
      if (!tag || stack.length > 16) throw new Error("Unsupported bank XML");
      const node: XmlNode = { name: tag[1], text: "", children: [] };
      current.children.push(node);
      if (!tag[2].includes("/")) stack.push(node);
    } else {
      current.text += decode(token);
    }
  }
  if (stack.length !== 1 || root.children.length !== 1 || root.text.trim())
    throw new Error("Invalid bank response");
  const response = root.children[0];
  if (response.name !== "response" || response.text.trim())
    throw new Error("Invalid bank response");
  const fields: Record<string, string> = Object.create(null);
  const signatureFields: Record<string, string> = Object.create(null);
  function flatten(nodes: XmlNode[], prefix = "") {
    nodes.forEach((node, index) => {
      const key = `${prefix}${node.name}${String(index + 1).padStart(3, "0")}`;
      if (node.children.length) {
        if (node.text.trim()) throw new Error("Mixed bank XML");
        flatten(node.children, key);
      } else signatureFields[key] = node.text;
    });
  }
  for (const node of response.children) {
    if (node.name in fields) throw new Error("Duplicate bank field");
    fields[node.name] = node.children.length ? "" : node.text;
  }
  flatten(response.children.filter((node) => node.name !== "pg_sig"));
  return { fields, signatureFields };
}
