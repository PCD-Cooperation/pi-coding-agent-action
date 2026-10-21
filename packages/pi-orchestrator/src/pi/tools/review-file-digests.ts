import { defineTool, type ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { digestReviewFiles, type ReviewDigestReceipt } from '../../review/work-digests';
import type { ReviewSnapshot } from '../../review/types';
import { PI_ACTION_NAMESPACE } from './metadata';

export function createReviewFileDigestsFactory(snapshot: ReviewSnapshot): ExtensionFactory {
  return pi => {
    pi.registerTool(
      defineTool({
        name: 'review_file_digests',
        label: 'Review file digests',
        description:
          'Compute native SHA-256 receipts from pinned snapshot files without rendering source. UTF-8 LF preserves BOM and whitespace, converting CRLF and lone CR to LF.',
        namespace: PI_ACTION_NAMESPACE,
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        parameters: Type.Object(
          {
            paths: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
              minItems: 1,
              maxItems: 8,
            }),
            role: Type.Union([
              Type.Literal('H'),
              Type.Literal('M'),
              Type.Literal('B'),
              Type.Literal('P'),
            ]),
            normalization: Type.Union([
              Type.Literal('sha256-raw-v1'),
              Type.Literal('sha256-utf8-lf-v1'),
            ]),
          },
          { additionalProperties: false }
        ),
        async execute(_id, params, signal) {
          if (signal?.aborted) {
            return {
              content: [{ type: 'text', text: 'Digest computation cancelled' }],
              details: { cancelled: true, receipts: [] as ReviewDigestReceipt[] },
            };
          }
          const receipts = await digestReviewFiles(
            snapshot,
            params.paths,
            params.normalization,
            signal,
            params.role
          );
          return {
            content: [{ type: 'text', text: JSON.stringify(receipts) }],
            details: { cancelled: false, receipts },
            structuredContent: { receipts: receipts.map(receipt => ({ ...receipt })) },
          };
        },
      })
    );
  };
}
