import harden from '@agoric/harden';
import Nat from '@agoric/nat';
import { makeLiveSlots } from './liveSlots';
import { QCLASS, makeMarshal } from './marshal';

export default function buildKernel(kernelEndowments) {
  console.log('in buildKernel', kernelEndowments);
  const { setImmediate } = kernelEndowments;

  const log = [];

  let running = false;
  const vats = harden(new Map());
  const runQueue = [];
  // kernelSlots[fromVatID] = { outbound, inbound }
  // outbound[fromSlotID] = { vatID, slotID }
  // inbound[`${toVatID}.${toSlotID}`] = fromSlotID
  const kernelSlots = harden(new Map());
  // nextImportIndex.get(vatID) = -number
  const nextImportIndex = harden(new Map());

  // we define three types of slot identifiers: inbound, neutral, outbound
  // * outbound is what syscall.send(slots=) contains, it is always scoped to
  //   the sending vat, and the values are either negative (imports) or
  //   positive (exports). Message targets are always positive/exports.
  // * middle is stored in runQueue, and contains (vatID, exportID) pairs,
  //   where exportID is always positive
  // * inbound is passed into deliver(slots=), is always scoped to the
  //   receiving/target vat, and the values are either negative (imports) or
  //   positive (exports)
  //
  // * To convert outbound->middle, we look up negative-imports in
  //   kernelSlots, and just appends the sending vatID to positive-exports
  //
  // * To convert middle->inbound, we remove the vatID when it matches the
  //   receiving vat (and then deliver a positive-export), and we look up the
  //   others in kernelSlots (adding one if necessary) to deliver
  //   negative-imports

  function mapOutbound(fromVatID, fromSlotID) {
    // fromVatID just referenced fromSlotID in an argument (or as the target
    // of a send), what { vatID, slotID } are they talking about?

    // fromSlotID might be positive (an export of fromVatID), or negative (an
    // import from somewhere else). Exports don't need translation into the
    // neutral { vatID, slotID } format.
    if (fromSlotID > 0) {
      return { vatID: fromVatID, slotID: fromSlotID };
    }
    // imports (of fromVatID) must be translated into the neutral
    // non-Vat-specific form. These will always be exports of somebody else.
    return kernelSlots.get(fromVatID).outbound.get(fromSlotID);
  }

  function allocateImportIndex(vatID) {
    const i = nextImportIndex.get(vatID);
    nextImportIndex.set(vatID, i - 1);
    return i;
  }

  function mapInbound(forVatID, vatID, slotID) {
    // decide what slotID to give to 'forVatID', so when they reference it
    // later in an argument, it will be mapped to vatID/slotID.
    console.log(`mapInbound for ${forVatID} of ${vatID}/${slotID}`);
    // slotID is always positive, since it is somebody else's export
    Nat(slotID);

    if (vatID === forVatID) {
      // this is returning home, just use slotID
      return slotID;
    }

    const m = kernelSlots.get(forVatID);
    const key = `${vatID}.${slotID}`; // ugh javascript
    if (!m.inbound.has(key)) {
      // must add both directions
      const newSlotID = allocateImportIndex(forVatID);
      console.log(` adding ${newSlotID}`);
      Nat(-newSlotID); // always negative: import for forVatID
      m.inbound.set(key, newSlotID);
      m.outbound.set(newSlotID, harden({ vatID, slotID }));
    }
    return m.inbound.get(key);
  }

  const syscallBase = harden({
    send(fromVatID, targetSlot, method, argsString, vatSlots) {
      const target = mapOutbound(fromVatID, targetSlot);
      if (!target)
        throw Error(`unable to find target for ${fromVatID}/${targetSlot}`);
      const slots = vatSlots.map(outSlotID =>
        mapOutbound(fromVatID, outSlotID),
      );
      runQueue.push({
        vatID: target.vatID,
        facetID: target.slotID,
        method,
        argsString,
        slots,
      });
    },
  });

  function syscallForVatID(fromVatID) {
    function send(targetSlot, method, argsString, vatSlots) {
      return syscallBase.send(
        fromVatID,
        targetSlot,
        method,
        argsString,
        vatSlots,
      );
    }

    return harden({
      send,

      log(str) {
        log.push(`${str}`);
      },

      // TODO: this is temporary, obviously vats shouldn't be able to pause the kernel
      pause() {
        running = false;
      },
    });
    // TODO: since we pass this in on each deliver() call, consider
    // destroying this object after each delivery, to discourage vat code
    // from retaining it. OTOH if we don't expect to ever change it, that's
    // wasteful and limiting.
  }

  function addVat(vatID, setup) {
    const helpers = harden({
      vatID,
      makeLiveSlots,
      log(str) {
        log.push(`${str}`);
      },
    });
    const dispatch = setup(helpers);
    const vat = harden({
      id: vatID,
      dispatch,
      syscall: syscallForVatID(vatID),
    });
    vats.set(vatID, vat);
    if (!kernelSlots.has(vatID)) {
      kernelSlots.set(vatID, {
        outbound: harden(new Map()),
        inbound: harden(new Map()),
      });
    }
    nextImportIndex.set(vatID, -1);
  }

  async function deliverOneMessage(message) {
    const targetVatID = message.vatID;
    const vat = vats.get(targetVatID);
    console.log(`deliver mapping ${JSON.stringify(message)}`);
    const inputSlots = message.slots.map(s =>
      mapInbound(targetVatID, s.vatID, s.slotID),
    );

    // the delivery might cause some number of (native) Promises to be
    // created and resolved, so we use the IO queue to detect when the
    // Promise queue is empty. The IO queue (setImmediate and setTimeout) is
    // lower-priority than the Promise queue on browsers and Node 11, but on
    // Node 10 it is higher. So this trick requires Node 11.
    // https://jsblog.insiderattack.net/new-changes-to-timers-and-microtasks-from-node-v11-0-0-and-above-68d112743eb3

    let r;
    const queueEmptyP = new Promise(res => (r = res));
    setImmediate(() => r());

    // protect dispatch with promise/then
    Promise.resolve()
      .then(() => {
        // TODO: deliver syscall() once during setup(), instead of every time
        // through dispatch(), although it shouldn't be called until dispatch
        vat.dispatch(
          vat.syscall,
          message.facetID,
          message.method,
          message.argsString,
          inputSlots,
        );
      })
      .then(undefined, err => {
        console.log(
          `vat[${targetVatID}][${message.facetID}].${
            message.method
          } dispatch failed: ${err}`,
        );
      });

    await queueEmptyP;
  }

  function addImport(forVatID, vatID, slotID) {
    Nat(slotID); // export
    const newSlotID = mapInbound(forVatID, vatID, slotID);
    Nat(-newSlotID); // import
    return newSlotID;
  }

  function queue(vatID, facetID, method, argsString, slots = []) {
    // queue a message on the end of the queue, with 'neutral' slotIDs. Use
    // 'step' or 'run' to execute it
    runQueue.push({
      vatID: `${vatID}`,
      facetID: Nat(facetID), // always export/positive
      method: `${method}`,
      argsString: `${argsString}`,
      slots: slots.map(s => ({ vatID: `${s.vatID}`, slotID: s.slotID })),
    });
  }

  function callBootstrap(vatID, argvString) {
    const argv = JSON.parse(`${argvString}`);
    // each key of 'vats' will be serialized as a reference to its obj0
    const vrefs = new Map();
    const vatObj0s = {};
    Array.from(vats.entries()).forEach(e => {
      const targetVatID = e[0];
      if (targetVatID !== vatID) {
        // don't give _bootstrap to itself
        const vref = harden({}); // marker
        vatObj0s[targetVatID] = vref;
        vrefs.set(vref, { vatID: targetVatID, slotID: 0 });
      }
    });

    function serializeSlot(vref, slots, slotMap) {
      if (!vrefs.has(vref)) {
        console.log(`oops ${vref}`, vref);
        throw Error('bootstrap got unexpected pass-by-presence');
      }
      if (!slotMap.has(vref)) {
        const slotIndex = slots.length;
        slots.push(vrefs.get(vref));
        console.log(`--slots now ${JSON.stringify(slots)}`);
        slotMap.set(vref, slotIndex);
      }
      const slotIndex = slotMap.get(vref);
      return harden({ [QCLASS]: 'slot', index: slotIndex });
    }
    const m = makeMarshal(serializeSlot);
    const s = m.serialize(harden({ args: [argv, vatObj0s] }));
    // queue() takes 'neutral' { vatID, slotID } objects in s.slots
    queue(vatID, 0, 'bootstrap', s.argsString, s.slots);
  }

  const kernel = harden({
    addVat(vatID, setup) {
      harden(setup);
      // 'setup' must be an in-realm function. This test guards against
      // accidents, but not against malice. MarkM thinks there is no reliable
      // way to test this.
      if (!(setup instanceof Function)) {
        throw Error('setup is not an in-realm function');
      }
      addVat(`${vatID}`, setup);
    },

    callBootstrap,

    connect(fromVatID, importID, toVatID, exportID) {
      Nat(-importID);
      Nat(exportID);
      const key = `${toVatID}.${exportID}`;

      const m = kernelSlots.get(fromVatID);
      m.outbound.set(importID, { vatID: toVatID, slotID: exportID });
      m.inbound.set(key, importID);
    },

    addImport,

    log(str) {
      log.push(`${str}`);
    },

    dump() {
      const vatTables = Array.from(vats.entries()).map(e => {
        const vatID = e[0];
        // const vat = e[1];
        // TODO: find some way to expose these, the kernel doesn't see them
        return { vatID };
      });

      const kernelTable = [];
      kernelSlots.forEach((fb, vatID) => {
        fb.outbound.forEach((target, slotID) => {
          kernelTable.push([vatID, slotID, target.vatID, target.slotID]);
        });
      });

      function compareNumbers(a, b) {
        return a - b;
      }

      function compareStrings(a, b) {
        if (a > b) {
          return 1;
        }
        if (a < b) {
          return -1;
        }
        return 0;
      }

      kernelTable.sort(
        (a, b) =>
          compareStrings(a[0], b[0]) ||
          compareNumbers(a[1], b[1]) ||
          compareStrings(a[2], b[2]) ||
          compareNumbers(a[3], b[3]) ||
          0,
      );

      return { vatTables, kernelTable, runQueue, log };
    },

    async run() {
      // process all messages, until syscall.pause() is invoked
      running = true;
      while (running && runQueue.length) {
        // eslint-disable-next-line no-await-in-loop
        await deliverOneMessage(runQueue.shift());
      }
    },

    async drain() {
      // process all existing messages, but stop before processing new ones
      running = true;
      let remaining = runQueue.length;
      while (running && remaining) {
        // eslint-disable-next-line no-await-in-loop
        await deliverOneMessage(runQueue.shift());
        remaining -= 1;
      }
    },

    async step() {
      // process a single message
      if (runQueue.length) {
        await deliverOneMessage(runQueue.shift());
      }
    },

    sendFrom(vatID, targetID, method, argsString, slots) {
      vats.get(vatID).syscall.send(targetID, method, argsString, slots);
    },

    queue,
  });

  return kernel;
}