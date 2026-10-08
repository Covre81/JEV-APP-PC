import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export interface GraphNode {
  readonly id: string;
  readonly label: string;
  readonly community: string;
  readonly degree: number;
}

export interface GraphCommunity {
  readonly id: string;
  readonly topNodes: readonly GraphNode[]; // All nodes in the community, sorted by degree descending
  readonly description: string; // "node1, node2, node3, node4, node5" (the top 5 nodes by degree)
}

export interface GraphData {
  readonly path: string;
  readonly sha256: string;
  readonly project: string; // Name of the folder above graphify-out
  readonly isCurrent: boolean;
  readonly communities: readonly GraphCommunity[];
}

/**
 * Searches up to 2 levels deep from graphRoot for any graphify-out/graph.json files.
 */
export function findGraphs(root: string): string[] {
  const results: string[] = [];
  if (!root || !existsSync(root)) return results;

  const resolvedRoot = resolve(root);

  // Level 0
  const l0 = join(resolvedRoot, 'graphify-out', 'graph.json');
  if (existsSync(l0) && statSync(l0).isFile()) {
    results.push(l0);
  }

  // Level 1
  try {
    const items = readdirSync(resolvedRoot);
    for (const item of items) {
      if (item === '.' || item === '..' || item === 'node_modules' || item === '.git') continue;
      const p1 = join(resolvedRoot, item);
      try {
        if (statSync(p1).isDirectory()) {
          const l1 = join(p1, 'graphify-out', 'graph.json');
          if (existsSync(l1) && statSync(l1).isFile()) {
            results.push(l1);
          }

          // Level 2
          try {
            const subItems = readdirSync(p1);
            for (const subItem of subItems) {
              if (subItem === '.' || subItem === '..' || subItem === 'node_modules' || subItem === '.git') continue;
              const p2 = join(p1, subItem);
              try {
                if (statSync(p2).isDirectory()) {
                  const l2 = join(p2, 'graphify-out', 'graph.json');
                  if (existsSync(l2) && statSync(l2).isFile()) {
                    results.push(l2);
                  }
                }
              } catch {
                // Ignore errors
              }
            }
          } catch {
            // Ignore errors
          }
        }
      } catch {
        // Ignore errors
      }
    }
  } catch {
    // Ignore errors
  }

  return results;
}

/**
 * Parses and processes a graph.json file, calculating degrees and community summaries.
 * Returns undefined if JSON is broken.
 */
export function loadGraph(filePath: string, cwd: string): GraphData | undefined {
  try {
    const rawContent = readFileSync(filePath);
    const sha256 = createHash('sha256').update(rawContent).digest('hex');

    const graph = JSON.parse(rawContent.toString('utf8'));
    if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.links)) {
      return undefined;
    }

    // Determine project and if it's the current project
    const resolvedGraph = resolve(filePath);
    const resolvedCwd = resolve(cwd);
    const parentFolder = basename(dirname(dirname(resolvedGraph)));
    
    const isCurrent =
      resolvedGraph.startsWith(resolvedCwd) ||
      parentFolder.toLowerCase() === basename(resolvedCwd).toLowerCase();

    // 1. Calculate degree for each node based on links
    const degrees: Record<string, number> = {};
    for (const link of graph.links) {
      if (link.source === undefined || link.target === undefined) continue;
      const s = String(link.source);
      const t = String(link.target);
      degrees[s] = (degrees[s] ?? 0) + 1;
      degrees[t] = (degrees[t] ?? 0) + 1;
    }

    // 2. Group nodes by community
    const communityNodesMap: Record<string, any[]> = {};
    for (const node of graph.nodes) {
      if (node.id === undefined) continue;
      const cId = node.community !== undefined && node.community !== null ? String(node.community) : 'unassigned';
      if (!communityNodesMap[cId]) {
        communityNodesMap[cId] = [];
      }
      communityNodesMap[cId].push(node);
    }

    // 3. Process each community
    const communities: GraphCommunity[] = [];
    for (const [cId, nodes] of Object.entries(communityNodesMap)) {
      if (cId === 'unassigned') continue; // Skip nodes without community

      // Map to full node object with computed degree
      const mappedNodes: GraphNode[] = nodes.map((n) => ({
        id: String(n.id),
        label: String(n.label || n.id),
        community: cId,
        degree: degrees[String(n.id)] ?? 0,
      }));

      // Sort by degree descending, secondary alphabetical fallback on label/id
      mappedNodes.sort((a, b) => {
        if (b.degree !== a.degree) return b.degree - a.degree;
        return a.label.localeCompare(b.label);
      });

      // Top 5 nodes describe the community
      const top5 = mappedNodes.slice(0, 5);
      const description = top5.map((n) => n.label).join(', ');

      communities.push({
        id: cId,
        topNodes: mappedNodes,
        description,
      });
    }

    return {
      path: resolvedGraph,
      sha256,
      project: parentFolder,
      isCurrent,
      communities,
    };
  } catch {
    return undefined;
  }
}

/**
 * Scans CONTEXT_GRAPH_ROOT for all graphs and returns deduplicated GraphData objects.
 */
export function getGraphSources(root: string, cwd: string): readonly GraphData[] {
  const filePaths = findGraphs(root);
  const seenSha256 = new Set<string>();
  const graphs: GraphData[] = [];

  for (const filePath of filePaths) {
    const loaded = loadGraph(filePath, cwd);
    if (loaded && !seenSha256.has(loaded.sha256)) {
      seenSha256.add(loaded.sha256);
      graphs.push(loaded);
    }
  }

  return graphs;
}
