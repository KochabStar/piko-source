// Version retention policy for the source catalog.
//
// Every package keeps the most recent KEEP version groups. A group is a base
// version plus its "-piko.N" revisions (the same payload re-published with a
// fixed entry point), so pruning never splits a revision from its base.
// Registration order — the insertion order of index.versions, which the
// updater only ever appends to — is the recency order; semantic version
// comparison is unreliable here (timestamps, "a2" tags, four-part builds).

export const RETENTION_KEEP = 8;

export function versionGroup(version) {
  return version.replace(/-piko\.[0-9]+$/, "");
}

// The set of versions a package must still publish, given its index entry.
export function retainedVersions(entry, keep = RETENTION_KEEP) {
  const order = Object.keys(entry.versions),
    groups = [],
    byGroup = new Map();
  for (const version of order) {
    const group = versionGroup(version);
    if (!byGroup.has(group)) {
      byGroup.set(group, []);
      groups.push(group);
    }
    byGroup.get(group).push(version);
  }
  const keepGroups = new Set(groups.slice(-keep));
  return new Set(order.filter((v) => keepGroups.has(versionGroup(v))));
}

// Versions whose registration fell outside the retention window.
export function prunedVersions(entry, keep = RETENTION_KEEP) {
  const retained = retainedVersions(entry, keep);
  return Object.keys(entry.versions).filter((v) => !retained.has(v));
}

// Drop pruned version rows and any recipe that no remaining version uses.
// Mutates nothing: returns a new document, or the original when unchanged.
export function pruneDocument(document, entry, keep = RETENTION_KEEP) {
  const drop = new Set(prunedVersions(entry, keep));
  if (!drop.size) return document;
  const versions = {};
  for (const [version, row] of Object.entries(document.versions))
    if (!drop.has(version)) versions[version] = row;
  const used = new Set(Object.values(versions).map((row) => row.recipe));
  const recipes = Object.fromEntries(
    Object.entries(document.recipes).filter(([id]) => used.has(id)),
  );
  return { ...document, recipes, versions };
}
