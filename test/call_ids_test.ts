// Call aliases have one rule, used when a record is written and when it is matched: a response the gateway emitted
// always replays its own record. A client id maps to one provider id, and a provider id to one client id.
import { assertEquals } from '@std/assert'
import { bindCalls, type CallAliases, matchItems, remapItems } from '../src/call_ids.ts'
import type { InItem } from '../src/api/request.ts'
import { ItemDigest } from '../src/records.ts'

Deno.test('call aliases: the writer keeps the mapping one-to-one both ways', () => {
  const aliases: CallAliases = []
  assertEquals(bindCalls(aliases, [['client-a', 'provider-a'], ['client-b', 'provider-b']]), true)
  assertEquals(aliases, [['client-a', 'provider-a'], ['client-b', 'provider-b']])
  // a pair already bound is kept once, and a contradiction is refused
  assertEquals(bindCalls(aliases, [['client-a', 'provider-a']]), true)
  assertEquals(aliases.length, 2)
  assertEquals(bindCalls([], [['client-a', 'provider-a'], ['client-b', 'provider-a']]), false)
  assertEquals(bindCalls([], [['client-a', 'provider-a'], ['client-a', 'provider-b']]), false)
})

Deno.test('call aliases: a record written with that rule is matched with it', () => {
  const items: InItem[] = [
    { kind: 'function_call', callId: 'client-a', name: 'echo', arguments: '{"x":1}' },
    { kind: 'function_call_output', callId: 'client-a', parts: [{ type: 'text', text: 'out' }] },
  ]
  const aliases: CallAliases = []
  assertEquals(bindCalls(aliases, [['client-a', 'provider-a']]), true)
  const digest = new ItemDigest(remapItems(items, aliases)).finish()
  assertEquals(matchItems(items, digest, ['provider-a'], []), [['client-a', 'provider-a']])
  assertEquals(matchItems(items, digest, ['provider-a'], aliases), [['client-a', 'provider-a']])
  // the matcher refuses what the writer refuses: one provider id with two client ids
  const two: InItem[] = [
    { kind: 'function_call', callId: 'client-a', name: 'echo', arguments: '{}' },
    { kind: 'function_call_output', callId: 'client-a', parts: [{ type: 'text', text: 'out' }] },
    { kind: 'function_call', callId: 'client-b', name: 'echo', arguments: '{}' },
    { kind: 'function_call_output', callId: 'client-b', parts: [{ type: 'text', text: 'out' }] },
  ]
  const twoDigest = new ItemDigest(remapItems(two, [['client-a', 'provider-a'], ['client-b', 'provider-b']])).finish()
  assertEquals(matchItems(two, twoDigest, ['provider-a', 'provider-b'], []), [['client-a', 'provider-a'], ['client-b', 'provider-b']])
  assertEquals(matchItems(two, twoDigest, ['provider-a', 'provider-a'], []), null)
  assertEquals(bindCalls([], [['client-a', 'provider-a'], ['client-b', 'provider-a']]), false)
})
