import { describe, expect, it } from 'vitest';

import { buildPathTree } from '../src/utils/path-tree.js';

describe('buildPathTree', () => {
  it('groups URLs by reversed hostname parts and path segments', () => {
    const result = buildPathTree([
      'https://example.com/path-a?utm_source=test',
      'https://example.com/path-b',
      'https://example.com/path-b/b1?x=1',
      'https://example.com/path-b/b2#section',
      'https://example.com/path-b/b2?ignored=1',
    ]);

    expect(result.totalUrls).toBe(4);
    expect(result.root.children).toEqual([
      {
        name: 'com',
        kind: 'domain',
        pageCount: 4,
        terminalCount: 0,
        children: [
          {
            name: 'example',
            kind: 'domain',
            pageCount: 4,
            terminalCount: 0,
            children: [
              {
                name: 'path-a',
                kind: 'path',
                pageCount: 1,
                terminalCount: 1,
                children: [],
              },
              {
                name: 'path-b',
                kind: 'path',
                pageCount: 3,
                terminalCount: 1,
                children: [
                  {
                    name: 'b1',
                    kind: 'path',
                    pageCount: 1,
                    terminalCount: 1,
                    children: [],
                  },
                  {
                    name: 'b2',
                    kind: 'path',
                    pageCount: 1,
                    terminalCount: 1,
                    children: [],
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);
    expect(result.text).toBe([
      '└── com',
      '    └── example',
      '        ├── path-a',
      '        └── path-b',
      '            ├── b1',
      '            └── b2',
    ].join('\n'));
  });

  it('skips invalid URLs', () => {
    const result = buildPathTree(['not-a-url', 'https://example.com']);

    expect(result.totalUrls).toBe(1);
    expect(result.skippedUrls).toEqual(['not-a-url']);
  });

  it('keeps same-name domain and path nodes distinct', () => {
    const result = buildPathTree([
      'https://example.com/www',
      'https://www.example.com',
    ]);
    const example = result.root.children[0]!.children[0]!;

    expect(example.children).toEqual([
      {
        name: 'www',
        kind: 'domain',
        pageCount: 1,
        terminalCount: 1,
        children: [],
      },
      {
        name: 'www',
        kind: 'path',
        pageCount: 1,
        terminalCount: 1,
        children: [],
      },
    ]);
  });
});
