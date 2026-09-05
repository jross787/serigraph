// Read-only projections of the map's catalog. No records or connector calls.
export function catalogObjects(model, { systemId = '', query = '', fieldId = '' } = {}) {
  const catalog = model?.dataExplorer;
  if (!catalog) return [];
  const fields = new Map((catalog.canonicalFields ?? []).map(field => [field.id, field]));
  const objects = new Map(catalog.objects.map(object => [object.id, object]));
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return catalog.objects.map(object => ({
    ...object,
    systemLabel: model.elementById.get(object.system)?.label ?? object.system,
    bindings: (catalog.fieldBindings ?? []).filter(binding => binding.object === object.id)
      .map(binding => ({ ...binding, field: fields.get(binding.canonicalField) })),
    connections: catalog.flows.filter(flow => flow.from === object.id || flow.to === object.id)
      .map(flow => ({
        ...flow,
        direction: flow.from === flow.to ? 'internal' : flow.from === object.id ? 'outgoing' : 'incoming',
        peer: objects.get(flow.from === object.id ? flow.to : flow.from),
      })),
  })).filter(object => {
    if (systemId && object.system !== systemId) return false;
    if (fieldId && !object.bindings.some(binding => binding.canonicalField === fieldId)) return false;
    const text = [object.id, object.sourceName, object.systemLabel, object.system, object.entityType,
      ...object.bindings.flatMap(binding => [binding.sourceField, binding.canonicalField, binding.field?.label])]
      .join(' ').toLowerCase();
    return terms.every(term => text.includes(term));
  });
}

// Uses the app's DOM helper so catalog text is never interpreted as markup.
export function renderCatalog(panel, model, view, h, { change, close, locate }) {
  const objects = catalogObjects(model);
  const object = objects.find(item => item.id === view.objectId);
  const systems = [...new Set(objects.map(item => item.system))];
  const button = (label, onClick, className = 'catalog-link') => h('button', {
    type: 'button', class: className, onClick,
  }, label);
  const empty = text => h('p', { class: 'catalog-empty' }, text);
  const openObject = id => change({ objectId: id });
  const head = h('div', { class: 'panel-head' },
    h('div', { class: 'titles' },
      h('span', { class: 'inspector-eyebrow' }, 'Explore the map'),
      h('h2', {}, 'Data catalog'),
      h('p', { class: 'catalog-summary' }, `${systems.length} systems · ${objects.length} objects · ${(model.dataExplorer.canonicalFields ?? []).length} canonical fields`)),
    button('Close', close, 'panel-close'));
  const notice = h('p', { class: 'catalog-notice' },
    h('strong', {}, 'Catalog metadata · not live'),
    'Declared mappings and connections. Records, transfers, and system health are not verified.');
  const body = h('div', { class: 'panel-body' });

  if (object) {
    body.append(button('← Back to catalog', () => change({ objectId: null })),
      h('div', { class: 'catalog-object-head' },
        h('span', { class: 'catalog-system-label' }, object.systemLabel),
        h('h3', { tabindex: '-1', 'data-catalog-heading': '' }, object.sourceName),
        h('code', {}, object.id),
        h('p', {}, `${object.entityType} · Declared authority: ${object.authority}`),
        h('button', {
          type: 'button', class: 'catalog-link', 'data-catalog-locate': '',
          ...(model.placementsByElement.get(object.system)?.length
            ? { onClick: () => locate(object) }
            : { disabled: '', title: 'This system has no placement on the map.' }),
        }, model.placementsByElement.get(object.system)?.length ? 'Show system on map ↗' : 'System not placed on map')));

    const fields = h('section', { class: 'catalog-section', 'aria-label': 'Field mappings' },
      h('h3', {}, `Field mappings · ${object.bindings.length}`),
      h('p', { class: 'catalog-hint' }, 'Choose a canonical field to find its other locations.'));
    if (!object.bindings.length) fields.append(empty('No field mappings are documented for this object.'));
    for (const binding of object.bindings) {
      fields.append(h('div', { class: 'catalog-binding' },
        h('div', {}, h('code', {}, binding.sourceField), h('small', {}, binding.sourceDataType)),
        h('span', { class: 'catalog-arrow', 'aria-label': 'maps to' }, '→'),
        h('div', {}, button(binding.field?.label ?? binding.canonicalField,
          () => change({ objectId: null, fieldId: binding.canonicalField, systemId: '', query: '' })),
        h('code', {}, binding.canonicalField), h('small', {}, binding.field?.dataType ?? 'Type not documented')),
        binding.mappingType || binding.transformation
          ? h('p', { class: 'catalog-transformation' },
            [binding.mappingType, binding.transformation].filter(Boolean).join(' · ')) : null));
    }
    const flows = h('section', { class: 'catalog-section', 'aria-label': 'Declared connections' },
      h('h3', {}, `Declared connections · ${object.connections.length}`));
    if (!object.connections.length) flows.append(empty('No connections are documented for this object.'));
    for (const flow of object.connections) {
      const direction = { outgoing: 'To', incoming: 'From', internal: 'Within' }[flow.direction];
      const peerSystem = model.elementById.get(flow.peer.system)?.label ?? flow.peer.system;
      flows.append(h('div', { class: 'catalog-flow' },
        h('span', { class: 'catalog-system-label' }, `${direction} ${peerSystem} · ${flow.method}`),
        button(flow.peer.sourceName, () => openObject(flow.peer.id)),
        h('p', {}, flow.label)));
    }
    body.append(fields, flows);
  } else {
    const input = h('input', {
      type: 'search', class: 'f-input', placeholder: 'Find a system, object, or field…',
      'aria-label': 'Search data catalog', value: view.query,
    });
    const select = h('select', { class: 'f-select', 'aria-label': 'Filter by system' },
      h('option', { value: '' }, 'All systems'),
      systems.map(id => h('option', { value: id }, model.elementById.get(id)?.label ?? id)));
    select.value = view.systemId;
    const results = h('div', { class: 'catalog-results' });
    const count = h('p', { class: 'catalog-result-count', role: 'status' });
    const renderResults = () => {
      const matches = catalogObjects(model, view);
      count.textContent = `${matches.length} of ${objects.length} objects`;
      results.replaceChildren(...matches.map(item => h('button', {
        type: 'button', class: 'catalog-object', onClick: () => openObject(item.id),
      }, h('span', { class: 'catalog-system-label' }, item.systemLabel),
      h('strong', {}, item.sourceName),
      h('span', { class: 'catalog-object-meta' }, `${item.entityType} · ${item.bindings.length} mapped fields · ${item.connections.length} connection${item.connections.length === 1 ? '' : 's'}`))));
      if (!matches.length) results.append(empty(objects.length
        ? 'No objects match. Clear the search or choose another system.'
        : 'No data objects are documented in this catalog yet.'));
    };
    input.addEventListener('input', () => { view.query = input.value; renderResults(); });
    select.addEventListener('change', () => { view.systemId = select.value; renderResults(); });
    body.append(h('div', { class: 'catalog-filters' }, input, select));
    if (view.fieldId) {
      const field = (model.dataExplorer.canonicalFields ?? []).find(item => item.id === view.fieldId);
      body.append(h('div', { class: 'catalog-field-focus' },
        h('span', {}, 'Locations of ', h('strong', {}, field?.label ?? view.fieldId)),
        button('Clear field filter', () => change({ fieldId: '' }))));
    }
    body.append(count, results);
    renderResults();
  }
  panel.replaceChildren(head, notice, body);
}
