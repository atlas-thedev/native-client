const test = require('node:test');
const assert = require('node:assert/strict');
const { marked } = require('marked');

test('changelog markdown parses headings, bullets, bold, and code blocks', () => {
  let sample = `## Release v3.9.25
• Added modern Apple-style buttons
• Sleek **frosted glass** nametag
- Another change with standard dash
* Another change with asterisk

\`\`\`bash
npm run build
\`\`\`

Here is \`inline code\` and a [link](https://github.com/ohllama0909-alt/native-client).
`;

  // Normalize unicode bullets
  sample = sample.replace(/^([ \t]*)•[ \t]+/gm, '$1- ');
  const parsed = marked.parse(sample, { gfm: true, breaks: true });

  assert.match(parsed, /<h2.*>Release v3\.9\.25<\/h2>/);
  assert.match(parsed, /<li>Added modern Apple-style buttons<\/li>/);
  assert.match(parsed, /<strong>frosted glass<\/strong>/);
  assert.match(parsed, /<pre><code.*>npm run build\n<\/code><\/pre>/);
  assert.match(parsed, /<code>inline code<\/code>/);
  assert.match(parsed, /<a href="https:\/\/github\.com\/ohllama0909-alt\/native-client">link<\/a>/);
});
