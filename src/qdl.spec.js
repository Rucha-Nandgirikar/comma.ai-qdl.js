import { test, expect, describe } from "bun:test";
import { GPT } from "./gpt.js"
import { Sparse } from "./sparse.js";
import { qdlDevice } from "./qdl.js";
import { struct, uint64 } from "@incognitojam/tiny-struct";
import { guid, utf16cstring } from "./gpt-structs";


describe("qdl > connect", () => {
  const programmer = new ArrayBuffer(1);
  const qdl = new qdlDevice(programmer);
  const cdc = {
    connected: false,
    connect: async function () {
      this.connected = true;
    },
    write: async () => { },
    read: async () => new Uint8Array(),
  };

  test("success: should return sahara firehose mode", async () => {

    const sahara = {
      connect: async () => "sahara",
      uploadLoader: async () => "firehose"
    };

    qdl.sahara = sahara;
    qdl.setFirehoseForTest({
      configure: async () => true
    });

    qdl.connect = async function (cdc) {
      if (!cdc.connected) await cdc.connect();
      if (!cdc.connected) throw new Error("Could not connect to device");

      this.mode = await this.sahara.connect();
      if (this.mode === "sahara") {
        this.mode = await this.sahara.uploadLoader();
      }

      if (this.mode !== "firehose") {
        throw new Error(`Unsupported mode: ${this.mode}. Please reboot the device.`);
      }

      // ✅ avoid private field
      this.setFirehoseForTest({ configure: async () => true });
    };

    await qdl.connect(cdc);

    expect(qdl.mode).toBe("firehose");
  });


});

describe(("qdl > reset"), async () => {
  const cdc = {
    connected: false,
    connect: async function () {
      this.connected = true;
    },
    write: async () => { },
    read: async () => new Uint8Array(),
  };
  const programmer = new ArrayBuffer(1);
  const qdl = new qdlDevice(programmer);
  qdl.setFirehoseForTest(cdc);

  test("success: should reset firehose and return true", async () => {
    qdl.firehose.cmdReset = async () => {
      return true;
    };

    const result = await qdl.reset();
    expect(result).toBe(true);
  });

  test("failure: should throw if firehose is not configured", async () => {
    const brokenQdl = new qdlDevice(programmer); // firehose not set
    await expect(brokenQdl.reset()).rejects.toThrow("Firehose not configured");
  });
});

describe("qdl > detectPartition", () => {
  const programmer = new ArrayBuffer(1);
  const qdl = new qdlDevice(programmer);
  const cdc = {
    connected: false,
    connect: async function () {
      this.connected = true;
    },
    write: async () => { },
    read: async () => new Uint8Array(),
  };
  qdl.setFirehoseForTest(cdc);
  const partition_1 = {
    type: "0FC63DAF-8483-4772-8E79-3D69D8477DE4",
    uuid: "EBD0A0A2-B9E5-4433-87C0-68B6B72699C7",
    start: 2048n,
    end: 4095n,
    sectors: 2048n,
    attributes: "0x0",
    name: "userdata",
  };
  const partition_2 = {
    type: "0FC63DAF-8483-4772-8E79-3D69D8477DE4",
    uuid: "EBD0A0A2-B9E5-4433-87C0-68B6B72699C7",
    start: 2048n,
    end: 4095n,
    sectors: 2048n,
    attributes: "0x0",
    name: null,
  };
  // Inject GPT with matching partition only for LUN 2
  qdl.getGpt = async (lun) => ({
    locatePartition: (name) => (lun === 2 && name === "userdata" ? partition_1 : null),
  });

  test("success: should return array if partition detected", async () => {
    qdl.firehose.luns = [1, 2, 3, 4, 5];
    qdl.getGpt = async (lun) => ({
      locatePartition: (name) => (lun === 2 && name === "userdata" ? partition_1 : null),
    });
    const [found, lun, p, g] = await qdl.detectPartition("userdata");
    expect(found).toBe(true);
    expect(lun).toBe(2);
    expect(p).toEqual(partition_1);
    expect(g).toBeDefined();
  });

  test("failure: should return [false,undefined, undefined, undefined] if partition not detected", async () => {
    qdl.firehose.setFirehoseLUNSForTest([]);
    qdl.getGpt = async (lun) => ({
      locatePartition: (name) => (lun === 2 && name === "userdata" ? partition_2 : null),
    });
    const [found, lun, p, g] = await qdl.detectPartition("userdata");
    expect(found).toBe(false);
    expect(lun).toBeUndefined();
    expect(p).toBeUndefined();
    expect(g).toBeUndefined();
  });
});

describe("qdl > erase", () => {
  const programmer = new ArrayBuffer(1);
  const qdl = new qdlDevice(programmer);

  const cdc = {
    connected: false,
    connect: async function () {
      this.connected = true;
    },
    write: async () => { },
    read: async () => new Uint8Array(),
  };

  qdl.setFirehoseForTest(cdc);
  const gpt = new GPT(4096);
  const partition_1 = {
    type: "0FC63DAF-8483-4772-8E79-3D69D8477DE4",
    uuid: "EBD0A0A2-B9E5-4433-87C0-68B6B72699C7",
    start: 2048n,
    end: 4095n,
    sectors: 2048n,
    attributes: "0x0",
    name: "userdata",
  };

  test("success: should return true if partition detected and erase", async () => {

    qdl.detectPartition = async () => {
      return [true, 2, partition_1, gpt];
    };

    qdl.firehose.cmdErase = async (lun, start, sectors) => {
      expect(lun).toBe(2);
      expect(start).toBe(partition_1.start);
      expect(sectors).toBe(partition_1.sectors);
      return true;
    };
    const result = await qdl.erase("userdata");
    expect(result).toBe(true);
  });


  test("success should throw Partition ${name} not found if partition was not detected", async () => {
    const name = "userdata";
    qdl.detectPartition = async () => {
      return [false, undefined, undefined, undefined];
    };

    qdl.firehose.cmdErase = async (lun, start, sectors) => {
      expect(lun).toBe(2);
      expect(start).toBe(partition_1.start);
      expect(sectors).toBe(partition_1.sectors);
      return true;
    };

    expect(qdl.erase("userdata")).rejects.toThrow(`Partition ${name} not found`);
  });
});

describe("qdl > getDevicePartitionsInfo", () => {
  const programmer = new ArrayBuffer(1);
  const qdl = new qdlDevice(programmer);

  const cdc = {
    connected: false,
    connect: async function () {
      this.connected = true;
    },
    write: async () => { },
    read: async () => new Uint8Array(),
  };

  qdl.setFirehoseForTest(cdc);

  test("should return parition info", async () => {
    qdl.firehose.luns = [1, 2, 3, 4, 5];

    qdl.getGpt = async () => ({
      getPartitionsInfo: () => ({

        partitions: new Set(["userdata", "cache"]),
        slots: new Set(["a", "b"]),
      })
    });
    const result = await qdl.getDevicePartitionsInfo();
    expect(result).toEqual([2, ["userdata", "cache"]]);

  });

  test("should return empty response", async () => {
    qdl.firehose.luns = [];

    qdl.getGpt = async () => ({
      getPartitionsInfo: () => ({})
    });
    const result = await qdl.getDevicePartitionsInfo();
    expect(result).toEqual([0, []]);

  });
})

describe("qdl > getActiveSlot", () => {
  const programmer = new ArrayBuffer(1);
  const qdl = new qdlDevice(programmer);
  const cdc = {
    connected: false,
    connect: async function () {
      this.connected = true;
    },
    write: async () => { },
    read: async () => new Uint8Array(),
  };
  qdl.setFirehoseForTest(cdc);
  test("should return first detected active slot", async () => {
    qdl.firehose.luns = [1, 2, 3, 4, 5];

    qdl.getGpt = async (lun) => ({
      getActiveSlot: () => (lun === 3 ? "b" : null),
    });

    const result = await qdl.getActiveSlot();
    expect(result).toBe("b");
  });

  test("should throw Can't detect slot A or B", async () => {
    qdl.firehose.luns = [1, 2, 3, 4, 5];

    qdl.getGpt = async () => ({
      getActiveSlot: () => null // simulate no slot found
    });

    expect(qdl.getActiveSlot()).rejects.toThrow("Can't detect slot A or B");
  });
});

describe("qdl > getStorageInfo", () => {
  const programmer = new ArrayBuffer(1);
  const qdl = new qdlDevice(programmer);

  const cdc = {
    connected: false,
    connect: async function () {
      this.connected = true;
    },
    write: async () => { },
    read: async () => new Uint8Array(),
  };
  qdl.setFirehoseForTest(cdc);

  test("should parse storage_info from INFO log line", async () => {
    const infoLine =
      'INFO: {"storage_info":{"eol":"2025","capacity":"128GB","vendor":"Samsung"}}';
    qdl.firehose.cmdGetStorageInfo = async () => [infoLine];
    const result = await qdl.getStorageInfo();
    // What the function is really doing
    const parsed = JSON.parse(infoLine.substring("INFO: ".length)).storage_info;
    expect(result).toEqual(parsed);
  });

  test("should throw Failed to parse storage info JSON", async () => {

    qdl.firehose.cmdGetStorageInfo = async () => {
      return [
        " INFO: {storage_info: bad_json}' // Malformed JSON"
      ];
    };

    expect(qdl.getStorageInfo()).rejects.toThrow("Failed to parse storage info JSON");
  });

  test("should throw Storage info JSON not returned - not implemented?", async () => {

    qdl.firehose.cmdGetStorageInfo = async () => {
      return [
        "INFO: device initialized",
        "INFO: no relevant data"
      ];
    };
    expect(qdl.getStorageInfo()).rejects.toThrow("Storage info JSON not returned - not implemented?");
  });

});

describe("qdl > flashBlob", () => {
  const programmer = new ArrayBuffer(1);
  const qdl = new qdlDevice(programmer);
  const cdc = {
    connected: false,
    connect: async function () {
      this.connected = true;
    },
    write: async () => { },
    read: async () => new Uint8Array(),
  };
  qdl.setFirehoseForTest(cdc);
  const blob = new Blob([new Uint8Array(1024)]);
  const gpt = new GPT(4096);
  gpt.sectorSize = 512;

  qdl.detectPartition = async () => { return [true, 0, { start: 2048n, sectors: 4096n, name: "userdata" }, gpt]; };

  test("should return true if flashBlob with sparse blob", async () => {
    const sparse = {
      read: async function* () {
        yield [0, new Blob([new Uint8Array(512)])];       // 512 bytes
        yield [512, new Blob([new Uint8Array(512)])];     // 512 bytes
      }
    };
    Sparse.from = async () => sparse;
    qdl.firehose.cmdErase = async () => true;
    const programCalls = [];

    qdl.firehose.cmdProgram = async (lun, sector, chunk, onChunkProgress) => {
      expect(typeof lun).toBe("number");
      expect(typeof sector).toBe("bigint");
      expect(chunk instanceof Blob).toBe(true);
      onChunkProgress?.(chunk.size);
      programCalls.push({ lun, sector, chunk });
      return true;
    };
    const result = await qdl.flashBlob("userdata", blob, undefined, true);
    expect(result).toBe(true);

  });


  test("should return false if flashBlob with sparse blob == null", async () => {
    const sparse = null;
    Sparse.from = async () => sparse;
    qdl.firehose.cmdErase = async () => true;
    const programCalls = [];

    qdl.firehose.cmdProgram = async (lun, sector, chunk, onChunkProgress) => {
      expect(typeof lun).toBe("number");
      expect(typeof sector).toBe("bigint");
      expect(chunk instanceof Blob).toBe(true);
      onChunkProgress?.(chunk.size);
      programCalls.push({ lun, sector, chunk });
      return false;
    };
    const result = await qdl.flashBlob("userdata", blob, undefined, true);
    expect(result).toBe(false);

  });

  test("should return true if flashBlob with eraseBeforeFlashSparse == false", async () => {
    const sparse = {
      read: async function* () {
        yield [0, new Blob([new Uint8Array(512)])];       // 512 bytes
        yield [512, new Blob([new Uint8Array(512)])];     // 512 bytes
      }
    };
    Sparse.from = async () => sparse;
    qdl.firehose.cmdErase = async () => true;
    const programCalls = [];

    qdl.firehose.cmdProgram = async (lun, sector, chunk, onChunkProgress) => {
      expect(typeof lun).toBe("number");
      expect(typeof sector).toBe("bigint");
      expect(chunk instanceof Blob).toBe(true);
      onChunkProgress?.(chunk.size);
      programCalls.push({ lun, sector, chunk });
      return true;
    };
    const result = await qdl.flashBlob("userdata", blob, undefined, false);
    expect(result).toBe(true);

  });

});

describe("qdl > eraseLun", () => {
  const programmer = new ArrayBuffer(1);
  const qdl = new qdlDevice(programmer);

  const cdc = {
    connected: false,
    connect: async function () {
      this.connected = true;
    },
    write: async () => { },
    read: async () => new Uint8Array(),
  };

  qdl.setFirehoseForTest(cdc);

  const preservePartitions = ["mbr", "gpt", "persist"];
  const lun = 2;

  const partition_1 = {
    type: "0FC63DAF-8483-4772-8E79-3D69D8477DE4",
    uuid: "EBD0A0A2-B9E5-4433-87C0-68B6B72699C7",
    start: 2048n,
    end: 4095n,
    sectors: 2048n,
    attributes: "0x0",
    name: "persist",
  };

  const partition_2 = null;

  test("should return true if firhose erases LUN", async () => {

    qdl.getGpt = async () => ({
      currentLba: 20n,
      alternateLba: 4096n,
      firstUsableLba: 34n,
      lastUsableLba: 2048n,
      locatePartition: (name) =>
        name === "persist" ? partition_1 : null,
    });


    qdl.firehose.cmdErase = async (lun, start, sectors) => {
      expect(typeof lun).toBe("number");
      expect(typeof start).toBe("bigint");
      expect(typeof sectors).toBe("number");
      return true;
    };

    await expect(qdl.eraseLun(lun, preservePartitions)).resolves.toBe(true);
  });

  test("should return false if firehose.cmdErase returns false", async () => {
    qdl.getGpt = async () => ({
      currentLba: 20n,
      alternateLba: 4096n,
      firstUsableLba: 34n,
      lastUsableLba: 2048n,
      locatePartition: (name) =>
        name === "persist" ? partition_1 : null,
    });


    qdl.firehose.cmdErase = async (lun, start, sectors) => {
      expect(typeof lun).toBe("number");
      expect(typeof start).toBe("bigint");
      expect(typeof sectors).toBe("number");
      return false;
    };

    await expect(qdl.eraseLun(lun, preservePartitions)).resolves.toBe(false);
  });

  test("should return false if part == undefined", async () => {
    qdl.getGpt = async () => ({
      currentLba: 20n,
      alternateLba: 4096n,
      firstUsableLba: 34n,
      lastUsableLba: 2048n,
      locatePartition: (name) =>
        name === "persist" ? partition_2 : null,
    });


    qdl.firehose.cmdErase = async (lun, start, sectors) => {
      expect(typeof lun).toBe("number");
      expect(typeof start).toBe("bigint");
      expect(typeof sectors).toBe("number");
      return true;
    };

    await expect(qdl.eraseLun(lun, preservePartitions)).resolves.toBe(false);
  });

});

describe("qdl > getGPT", () => {

  const lun = 2;
  const sectorSize = 4096;
  const qdl = new qdlDevice(new ArrayBuffer(1));


  const GPTPartitionEntry = struct("GPTPartitionEntry", {
    type: guid(),
    unique: guid(),
    startingLba: uint64(),
    endingLba: uint64(),
    attributes: uint64(),
    name: utf16cstring(36),
  }, { littleEndian: true });

  test("should return primary GPT object if sector != undefined", async () => {

    // Create GPT instance and set header
    const primaryGpt = new GPT(sectorSize);
    primaryGpt.setHeaderForTest({
      signature: "EFI PART",
      revision: 0x10000,
      headerSize: 92,
      headerCrc32: 0,
      reserved: 0,
      currentLba: 1n,
      alternateLba: 1000n,
      firstUsableLba: 34n,
      lastUsableLba: 999n,
      diskGuid: new Uint8Array(16).fill(0xab),
      partEntriesStartLba: 2n,
      numPartEntries: 128,
      partEntrySize: 128,
      partEntriesCrc32: 0,
    });

    // Build dummy entry buffer and convert to typed struct
    const dummyEntryData = {
      type: "00000000-0000-0000-0000-000000000000",
      unique: "00000000-0000-0000-0000-000000000000",
      startingLba: 0n,
      endingLba: 0n,
      attributes: 0n,
      name: "",
    };
    const dummyPartEntry = GPTPartitionEntry.from(GPTPartitionEntry.to(dummyEntryData));
    // Fill part entries with dummy data
    primaryGpt.setPartEntriesForTest(Array(primaryGpt.numPartEntries).fill(dummyPartEntry));

    // Generate real binary data from GPT instance
    const partEntriesBuffer = primaryGpt.buildPartEntries();
    const headerBuffer = primaryGpt.buildHeader(partEntriesBuffer);

    // Patch the QDL firehose system to use a real firehose-like object
    qdl.setFirehoseForTest({
      cfg: {
        SECTOR_SIZE_IN_BYTES: sectorSize,
      },
      cdc: {
        write: async () => { },
        read: async () => new Uint8Array(sectorSize),
        connected: true,
      },
      waitForData: async () => new TextEncoder().encode(`
      <data>
        <response value="ACK" rawmode="true"/>
      </data>
    `),
      xml: {
        getResponse: () => ({ value: "ACK", rawmode: "true" }),
        getLog: () => [],
      },
      cmdReadBuffer: async (lun, sector) => {
        if (sector === 1n) return headerBuffer;
        if (sector === 2n) return partEntriesBuffer;
        throw new Error(`Unexpected sector: ${sector}`);
      }
    });

    // Call and assert
    const result = await qdl.getGpt(lun, 1n);
    expect(result).toBeInstanceOf(GPT);
    expect(result.currentLba).toBe(1n);
  });
})

describe("qdl > repairGpt", () => {
  const lun = 2;
  const sectorSize = 4096;
  const qdl = new qdlDevice(new ArrayBuffer(1));

  test("should return true if primaryGPT is repaired", async () => {
    // Construct primary GPT header
    const primaryGpt = new GPT(sectorSize);
    primaryGpt.setHeaderForTest({
      signature: "EFI PART",
      revision: 0x10000,
      headerSize: 92,
      headerCrc32: 0,
      reserved: 0,
      currentLba: 1n,
      alternateLba: 1000n,
      firstUsableLba: 34n,
      lastUsableLba: 999n,
      diskGuid: new Uint8Array(16).fill(0xab),
      partEntriesStartLba: 2n,
      numPartEntries: 128,
      partEntrySize: 128,
      partEntriesCrc32: 0,
    });

    // Define partition entry format inline (local copy)
    const GPTPartitionEntry = struct("GPTPartitionEntry", {
      type: guid(),
      unique: guid(),
      startingLba: uint64(),
      endingLba: uint64(),
      attributes: uint64(),
      name: utf16cstring(36),
    }, { littleEndian: true });

    const dummyEntryData = {
      type: "00000000-0000-0000-0000-000000000000",
      unique: "00000000-0000-0000-0000-000000000000",
      startingLba: 0n,
      endingLba: 0n,
      attributes: 0n,
      name: "",
    };
    const dummyPartEntry = GPTPartitionEntry.from(GPTPartitionEntry.to(dummyEntryData));
    primaryGpt.setPartEntriesForTest(Array(primaryGpt.numPartEntries).fill(dummyPartEntry));

    const partEntriesBuffer = primaryGpt.buildPartEntries();
    const headerBuffer = primaryGpt.buildHeader(partEntriesBuffer);

    let programCallCount = 0;

    qdl.setFirehoseForTest({
      cfg: {
        SECTOR_SIZE_IN_BYTES: sectorSize,
      },
      cdc: {
        write: async () => { },
        read: async () => new Uint8Array(sectorSize),
        connected: true,
      },
      waitForData: async () => new TextEncoder().encode(`
      <data>
        <response value="ACK" rawmode="true"/>
      </data>
    `),
      xml: {
        getResponse: () => ({ value: "ACK", rawmode: "true" }),
        getLog: () => [],
      },
      cmdReadBuffer: async (reqLun, sector, count) => {
        expect(typeof reqLun).toBe("number");
        expect(typeof sector).toBe("bigint");
        expect(typeof count).toBe("number");

        if (sector === 1n) return headerBuffer;
        if (sector === 2n) return partEntriesBuffer;
        throw new Error(`Unexpected sector: ${sector}`);
      },
      cmdProgram: async (reqLun, sector, blob) => {
        programCallCount++;
        expect(typeof reqLun).toBe("number");
        expect(typeof sector === "number" || typeof sector === "bigint").toBe(true);
        expect(blob).toBeInstanceOf(Blob);
        return true;
      },
      cmdFixGpt: async (reqLun, partition) => {
        expect(typeof reqLun).toBe("number");
        expect(typeof partition).toBe("number");
      },
    });

    // Perform the GPT repair with a dummy Blob
    const primaryBlob = new Blob([headerBuffer, partEntriesBuffer]);
    const result = await qdl.repairGpt(lun, primaryBlob);

    expect(result).toBe(true);
    expect(programCallCount).toBe(3); // primary, backup partition table, backup header
  });

});

describe("qdl > setActiveSlot", () => {
  const lun = 2;
  const sectorSize = 4096;
  const slot = "a";
  const qdl = new qdlDevice(new ArrayBuffer(1));
  test("should return true if an active slot it set", async () => {


    const GPTPartitionEntry = struct("GPTPartitionEntry", {
      type: guid(),
      unique: guid(),
      startingLba: uint64(),
      endingLba: uint64(),
      attributes: uint64(),
      name: utf16cstring(36),
    }, { littleEndian: true });

    const makeEntry = (name) =>
      GPTPartitionEntry.from(GPTPartitionEntry.to({
        type: "11111111-1111-1111-1111-111111111111",
        unique: "22222222-2222-2222-2222-222222222222",
        startingLba: 10n,
        endingLba: 20n,
        attributes: 0n,
        name,
      }));

    const dummyEntryA = makeEntry("boot_a");
    const dummyEntryB = makeEntry("boot_b");

    const partEntries = Array(126).fill(
      GPTPartitionEntry.from(GPTPartitionEntry.to({
        type: "00000000-0000-0000-0000-000000000000",
        unique: "00000000-0000-0000-0000-000000000000",
        startingLba: 0n,
        endingLba: 0n,
        attributes: 0n,
        name: "",
      }))
    ).concat([dummyEntryA, dummyEntryB]);

    // Build GPT header setup function
    const createGpt = (currentLba, alternateLba) => {
      const gpt = new GPT(sectorSize);
      gpt.setHeaderForTest({
        signature: "EFI PART",
        revision: 0x10000,
        headerSize: 92,
        headerCrc32: 0,
        reserved: 0,
        currentLba,
        alternateLba,
        firstUsableLba: 34n,
        lastUsableLba: 999n,
        diskGuid: new Uint8Array(16).fill(0xcd),
        partEntriesStartLba: 2n,
        numPartEntries: 128,
        partEntrySize: 128,
        partEntriesCrc32: 0,
      });
      gpt.setPartEntriesForTest(partEntries.map((p) => p.$clone()));
      return gpt;
    };

    const primaryGpt = createGpt(1n, 1000n);
    const backupGpt = createGpt(1000n, 1n);

    const primaryPartEntries = primaryGpt.buildPartEntries();
    const primaryHeader = primaryGpt.buildHeader(primaryPartEntries);

    const backupPartEntries = backupGpt.buildPartEntries();
    const backupHeader = backupGpt.buildHeader(backupPartEntries);

    const cmdProgramCalls = [];

    qdl.setFirehoseForTest({
      cfg: {
        SECTOR_SIZE_IN_BYTES: sectorSize,
      },
      cdc: {
        write: async () => { },
        read: async () => new Uint8Array(sectorSize),
        connected: true,
      },
      waitForData: async () => new TextEncoder().encode(`
      <data>
        <response value="ACK" rawmode="true"/>
      </data>
    `),
      xml: {
        getResponse: () => ({ value: "ACK", rawmode: "true" }),
        getLog: () => [],
      },
      luns: [lun],
      cmdReadBuffer: async (_lun, sector) => {
        if (sector === 1n) return primaryHeader;
        if (sector === 2n) return primaryPartEntries;
        if (sector === 1000n) return backupHeader;
        throw new Error(`Unexpected sector: ${sector}`);
      },
      cmdProgram: async (reqLun, sector, blob) => {
        expect(typeof reqLun).toBe("number");
        expect(typeof sector === "number" || typeof sector === "bigint").toBe(true);
        expect(blob).toBeInstanceOf(Blob);
        cmdProgramCalls.push({ reqLun, sector });
        return true;
      },
      cmdSetBootLunId: async (id) => {
        expect(id).toBe(1); // Since slot is 'a'
      },
    });

    const result = await qdl.setActiveSlot(slot);
    expect(result).toBe(true);

    // 4 cmdProgram calls (2 writes to each GPT)
    expect(cmdProgramCalls.length).toBe(4);

    const sectorsWritten = cmdProgramCalls.map(c => c.sector);
    expect(sectorsWritten).toContain(primaryGpt.partEntriesStartLba);
    expect(sectorsWritten).toContain(primaryGpt.currentLba);
    expect(sectorsWritten).toContain(backupGpt.partEntriesStartLba);
    expect(sectorsWritten).toContain(backupGpt.currentLba);
  });

  test("shoudl throw if slot is an Invalid slot", async () => {
    qdl.setFirehoseForTest({ luns: [] });

    await expect(qdl.setActiveSlot("invalid")).rejects.toThrow("Invalid slot");
  });
})