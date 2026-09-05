// Preloaded into the render command's Node process by
// `pdf-testkit check-determinism --clock-offset`, via NODE_OPTIONS=--require.
// Shifts every Date the process observes by PDF_TESTKIT_CLOCK_OFFSET_MS so a
// fixture that embeds "today" renders as it would tomorrow.
//
// Reach: this Node process and any Node child that inherits NODE_OPTIONS.
// It does NOT reach a browser page driven by Puppeteer/Playwright — the page
// has its own clock. Producers like that should read the same env var
// themselves when constructing dates for a fixture.
'use strict';
const offset = Number(process.env.PDF_TESTKIT_CLOCK_OFFSET_MS || 0);
if (offset) {
  const RealDate = Date;
  const realNow = RealDate.now;
  function FakeDate(...args) {
    if (!new.target) return new RealDate(realNow() + offset).toString();
    if (args.length === 0) return new RealDate(realNow() + offset);
    return new RealDate(...args);
  }
  FakeDate.prototype = RealDate.prototype;
  FakeDate.now = () => realNow() + offset;
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  Object.setPrototypeOf(FakeDate, RealDate);
  globalThis.Date = FakeDate;
}
