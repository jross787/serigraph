// Parse a project index (projects/<slug>/projects.yaml) into a normalized model.
// Runs in the browser, in Node, and inside standalone HTML exports.
import * as YAML from '../vendor/yaml.js';

export const PROJECT_INDEX_FILE = 'projects.yaml';

// Every field is optional: missing fields fall back to null / [] / {} and
// only malformed YAML or wrongly-typed fields land in errors.
export function parseProjectIndex(source) {
  const lineCounter = new YAML.LineCounter();
  const doc = YAML.parseDocument(source, { lineCounter });
  const errors = [];
  const index = { name: null, description: null, order: [], tags: {} };

  const lineOf = (path) => {
    // walk up the path until something with a source range is found
    for (let p = [...path]; ; p.pop()) {
      try {
        const node = p.length ? doc.getIn(p, true) : doc.contents;
        if (node && node.range) return lineCounter.linePos(node.range[0]).line;
      } catch { /* keep walking up */ }
      if (!p.length) return null;
    }
  };
  const err = (path, message) => errors.push({ message, line: lineOf(path), path: path.join('.') });

  for (const e of doc.errors) {
    const line = e.linePos ? e.linePos[0].line : null;
    errors.push({ message: `YAML syntax: ${e.message.split('\n')[0]}`, line, path: '' });
  }
  if (errors.length) return { ...index, errors };

  const data = doc.toJS() ?? {};
  if (typeof data !== 'object' || Array.isArray(data)) {
    err([], 'The project index must be a YAML map, e.g. name: Atlas Logistics');
    return { ...index, errors };
  }

  if (data.name != null) {
    if (typeof data.name === 'string') index.name = data.name;
    else err(['name'], '"name:" must be a string');
  }
  if (data.description != null) {
    if (typeof data.description === 'string') index.description = data.description;
    else err(['description'], '"description:" must be a string');
  }
  if (data.order != null) {
    if (Array.isArray(data.order)) {
      for (const slug of data.order) {
        if (typeof slug === 'string') index.order.push(slug);
        else err(['order'], '"order:" entries must be map slugs (strings)');
      }
    } else {
      err(['order'], '"order:" must be a list of map slugs');
    }
  }
  if (data.tags != null) {
    if (typeof data.tags === 'object' && !Array.isArray(data.tags)) {
      for (const [slug, tag] of Object.entries(data.tags)) {
        if (typeof tag === 'string') index.tags[slug] = tag;
        else err(['tags', slug], `Tag for "${slug}" must be a string`);
      }
    } else {
      err(['tags'], '"tags:" must be a map of map slug to label');
    }
  }

  return { ...index, errors };
}

// The badge label for a map tile, or null when the index has no tag for it.
export function mapProjectTag(index, slug) {
  const tag = index?.tags?.[slug];
  return typeof tag === 'string' && tag.trim() ? tag : null;
}
