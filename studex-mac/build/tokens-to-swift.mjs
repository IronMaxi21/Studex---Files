#!/usr/bin/env node
/**
 * Writes the shell's copy of the palette out of the stylesheet's.
 *
 * AppKit paints two things before any CSS exists: the window's background,
 * behind the title bar and behind the page while it loads, and the colour the
 * web view shows in the overscroll while a resize catches up. Both have to be
 * `--chrome-bg`, and until this script they were two literals in Theme.swift
 * with the hex written beside them in a comment — which is a copy, and copies
 * drift. One of them already had: the dark chrome was #131420 where the
 * stylesheet computes #121420.
 *
 * So the stylesheet is the original and this is the copy, made at build time
 * and checked in so that `swiftc App/*.swift` still compiles a working app on
 * its own. If tokens.css says something this cannot follow, it fails here
 * rather than quietly leaving yesterday's colour in place.
 *
 *   node build/tokens-to-swift.mjs web/css/tokens.css > App/ThemeTokens.swift
 */
import { readFileSync } from 'node:fs';

const source = process.argv[2];
if (!source) fail('usage: tokens-to-swift.mjs <tokens.css>');

const css = readFileSync(source, 'utf8');

function fail(message) {
  process.stderr.write(`tokens-to-swift: ${message}\n`);
  process.exit(1);
}

/** The declarations of one rule, from its selector to the line that closes it. */
function block(selector) {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) fail(`no ${selector} rule in ${source}`);
  const end = css.indexOf('\n}', start);
  if (end < 0) fail(`the ${selector} rule in ${source} is never closed`);
  return css.slice(start, end);
}

/** The value a custom property ends up with: the last one wins, as the cascade has it. */
function token(text, name) {
  const found = [...text.matchAll(new RegExp(`--${name}:\\s*([^;]+);`, 'g'))].pop();
  if (!found) fail(`${source} defines no --${name}`);
  return found[1].trim();
}

/** A hex colour as three channels in 0…1. Three digits or six, as CSS allows. */
function channels(value) {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!match) fail(`${value} is not a plain hex colour, and this only understands those`);
  const digits = match[1].length === 3
    ? [...match[1]].map((d) => d + d).join('')
    : match[1];
  return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16) / 255);
}

/**
 * `color-mix(in srgb, var(--x) N%, #hex)`, and nothing else.
 *
 * sRGB mixing is a straight weighted average of the encoded channels, which is
 * the one case where doing the arithmetic here matches what a browser does.
 * Any other colour space, and this would have to become a colour library.
 */
function resolve(value, palette) {
  if (value.startsWith('#')) return channels(value);
  const match = /^color-mix\(\s*in srgb\s*,\s*var\(--([a-z0-9-]+)\)\s+([\d.]+)%\s*,\s*(#[0-9a-f]{3,6})\s*\)$/i.exec(value);
  if (!match) fail(`cannot follow "${value}" — expected a hex colour or an srgb color-mix of one`);
  const [, name, percent, other] = match;
  const base = palette[name];
  if (!base) fail(`"${value}" mixes --${name}, which is not one of the colours read here`);
  const weight = Number(percent) / 100;
  const rest = channels(other);
  return channels(base).map((c, i) => c * weight + rest[i] * (1 - weight));
}

/** The light rule overrides the root one; anything it leaves alone is inherited. */
const dark = block(':root');
const light = `${dark}\n${block(":root[data-theme='light']")}`;

function chrome(text) {
  return resolve(token(text, 'chrome-bg'), { 'color-bg': token(text, 'color-bg') });
}

const round = (n) => n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '.0');
const hex = (rgb) => `#${rgb.map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('').toUpperCase()}`;

function swift(name, rgb) {
  const [r, g, b] = rgb;
  return `    /// \`--chrome-bg\`, ${hex(rgb)}.\n`
    + `    static let ${name} = NSColor(srgbRed: ${round(r)}, green: ${round(g)}, blue: ${round(b)}, alpha: 1)`;
}

process.stdout.write(`// Generated from web/css/tokens.css by build/tokens-to-swift.mjs. Do not edit.
//
// The window is painted before the stylesheet has been read — behind the title
// bar, behind the page on launch, and in the gap during a resize — so AppKit
// needs its own copy of the two chrome colours. This is that copy, made from
// the stylesheet at build time so it cannot drift away from it.
import AppKit

extension Theme {
${swift('lightChrome', chrome(light))}

${swift('darkChrome', chrome(dark))}
}
`);
