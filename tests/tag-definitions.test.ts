import { describe, expect, it } from 'vitest';

import {
  extractTagDefinitionCores,
  tagCoresToJsonl,
} from '../src/classification/tag-definitions.js';

describe('tag definitions', () => {
  it('extracts classifier core fields from exported label definitions', () => {
    const exported = {
      version: 1,
      groups: [{ name: 'ignored' }],
      labels: [
        {
          key: 'webpage_category_main',
          status: 'published',
          group_path: 'ignored',
          revision: {
            name: '网页类别-大类',
            description: '页面分类',
            value_type: 'multi_enum',
            values_config: {
              value_type: 'multi_enum',
              options: [
                { value: 'home', description: '首页', polarity: 'neutral' },
                { value: 'product', description: '产品页', polarity: 'neutral' },
              ],
            },
            nullable: true,
            allow_extra_values: false,
          },
        },
      ],
    };

    expect(extractTagDefinitionCores(exported)).toEqual([
      {
        key: 'webpage_category_main',
        name: '网页类别-大类',
        description: '页面分类',
        value_type: 'multi_enum',
        nullable: true,
        allow_extra_values: false,
        values_options: [
          { value: 'home', description: '首页' },
          { value: 'product', description: '产品页' },
        ],
      },
    ]);

    expect(tagCoresToJsonl(exported)).toBe(
      '{"key":"webpage_category_main","name":"网页类别-大类","description":"页面分类","value_type":"multi_enum","nullable":true,"allow_extra_values":false,"values_options":[{"value":"home","description":"首页"},{"value":"product","description":"产品页"}]}',
    );
  });
});
