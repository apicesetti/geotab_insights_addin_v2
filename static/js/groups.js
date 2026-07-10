// Resolución de jerarquía de Group de MyGeotab: un Group.children trae ids de
// sus hijos directos (lista plana, cada grupo con children: [{id: ...}, ...]),
// así que el árbol completo se arma en memoria a partir de una única llamada a Group.
// Port 1:1 de core/groups.py.

// rootGroupId + groupsById ({group_id: Group}) -> Set de ids (la raíz + todos
// sus descendientes). Si rootGroupId no está en groupsById, devuelve {rootGroupId}
// solo, para que el filtrado degrade a un match exacto en vez de no matchear nada.
function resolveGroupAndDescendants(rootGroupId, groupsById) {
  if (!groupsById[rootGroupId]) return new Set([rootGroupId]);

  const resolved = new Set([rootGroupId]);
  const queue = [rootGroupId];
  while (queue.length) {
    const currentId = queue.shift();
    const current = groupsById[currentId];
    if (!current) continue;
    for (const child of current.children || []) {
      const childId = typeof child === "object" ? child.id : child;
      if (childId && !resolved.has(childId)) {
        resolved.add(childId);
        queue.push(childId);
      }
    }
  }
  return resolved;
}

// Lista plana de Group -> lista de árboles anidados {id, name, children:[...]}
// partiendo de los grupos raíz (los que no aparecen como hijo de ningún otro).
function buildGroupTree(groups) {
  const groupsById = {};
  for (const g of groups) groupsById[g.id] = g;

  const childIds = new Set();
  for (const g of groups) {
    for (const child of g.children || []) {
      const childId = typeof child === "object" ? child.id : child;
      if (childId) childIds.add(childId);
    }
  }

  function buildNode(group) {
    const children = [];
    for (const child of group.children || []) {
      const childId = typeof child === "object" ? child.id : child;
      const childGroup = groupsById[childId];
      if (childGroup) children.push(buildNode(childGroup));
    }
    return { id: group.id, name: group.name || group.id, children };
  }

  const roots = groups.filter(g => !childIds.has(g.id));
  return roots.map(buildNode);
}
