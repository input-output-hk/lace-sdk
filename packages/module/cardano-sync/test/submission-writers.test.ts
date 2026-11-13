import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../../..');
const readSource = (path: string) =>
  ts.createSourceFile(
    path,
    readFileSync(resolve(root, path), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

const memberName = (node: ts.Node): string | undefined => {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node))
    return memberName(node.argumentExpression);
  return undefined;
};

const countNodes = (
  source: ts.Node,
  matches: (node: ts.Node) => boolean,
): number => {
  let count = 0;
  const visit = (node: ts.Node) => {
    if (matches(node)) count++;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return count;
};

// Each reviewed submit site has behavioral coverage in its writer's tests.
// New sites must join that inventory rather than silently bypassing ADR 74.
const writers = {
  'packages/module/blockchain-cardano/src/tx-executor-implementation/submit-tx.ts': 1,
  'packages/module/cardano-sync/src/store/side-effects/submit-tx.ts': 1,
  'packages/module/dapp-connector-cardano/src/browser/store/side-effects.ts': 1,
  'packages/module/dapp-connector-cardano/src/mobile/services/cip30-message-handler.ts': 1,
  'packages/module/migrate-multi-delegation/src/store/side-effects.ts': 2,
  'packages/module/migrate-wallet/src/store/side-effects/run-sweep.ts': 2,
};

const providerSubmissions = (source: ts.Node) =>
  countNodes(source, node => {
    if (
      (ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)) &&
      memberName(node.expression) === 'cardanoProvider' &&
      memberName(node) === 'submitTx'
    )
      return true;
    return (
      ts.isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      memberName(node.initializer) === 'cardanoProvider' &&
      ts.isObjectBindingPattern(node.name) &&
      node.name.elements.some(
        binding =>
          memberName(binding.propertyName ?? binding.name) === 'submitTx',
      )
    );
  });

const calls = (source: ts.Node, name: string) =>
  countNodes(
    source,
    node => ts.isCallExpression(node) && memberName(node.expression) === name,
  );

describe('Cardano submission writers', () => {
  it('has no unreviewed direct provider submission, including additional sites in an existing writer', () => {
    const found: Record<string, number> = {};
    for (const filePath of ts.sys.readDirectory(
      root,
      ['.ts', '.tsx'],
      ['**/node_modules/**'],
      ['packages/*/*/src/**/*', 'apps/*/src/**/*'],
    )) {
      const path = relative(root, filePath).replaceAll('\\', '/');
      const text = readFileSync(resolve(root, path), 'utf8');
      if (!text.includes('cardanoProvider')) continue;
      const count = providerSubmissions(readSource(path));
      if (count > 0) found[path] = count;
    }
    expect(found).toEqual(writers);
  });

  it.each([
    'provider.cardanoProvider.submitTx(bytes)',
    'cardanoProvider["submitTx"](bytes)',
    'const { submitTx: submit } = deps.cardanoProvider;',
  ])('detects a direct submission access: %s', text => {
    expect(
      providerSubmissions(
        ts.createSourceFile('writer.ts', text, ts.ScriptTarget.Latest, true),
      ),
    ).toBe(1);
  });

  it.each([
    ['packages/module/cardano-sync/src/store/side-effects/submit-tx.ts', 1],
    [
      'packages/module/dapp-connector-cardano/src/browser/store/side-effects.ts',
      1,
    ],
    [
      'packages/module/dapp-connector-cardano/src/mobile/store/side-effects.ts',
      1,
    ],
    ['packages/module/migrate-multi-delegation/src/store/side-effects.ts', 2],
    ['packages/module/migrate-wallet/src/store/side-effects/run-sweep.ts', 1],
    [
      'packages/module/blockchain-cardano/src/store/record-submitted-transactions-side-effect.ts',
      1,
    ],
  ] as const)('retains the in-flight recorder in %s', (path, count) => {
    expect(calls(readSource(path), 'recordInFlightTransaction')).toBe(count);
  });

  it('records both the single sweep and each accepted chunk through the sweep recorder', () => {
    expect(
      calls(
        readSource(
          'packages/module/migrate-wallet/src/store/side-effects/run-sweep.ts',
        ),
        'inFlightRecordAction',
      ),
    ).toBe(2);
  });

  it('registers the tx-executor recorder in the full Cardano store', () => {
    const source = readSource(
      'packages/module/blockchain-cardano/src/store/init-full.ts',
    );
    expect(
      countNodes(
        source,
        node =>
          ts.isArrayLiteralExpression(node) &&
          node.elements.some(
            element =>
              ts.isIdentifier(element) &&
              element.text === 'recordSubmittedTransactions',
          ),
      ),
    ).toBe(1);
  });
});
