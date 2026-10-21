package it.stefanogozzi.phonehaul

import org.junit.Assert.assertEquals
import org.junit.Test

class HashingTest {
    @Test fun bytesAboveSeventySevenPrintUnsigned() {
        assertEquals("000fff80", Hashing.hex(byteArrayOf(0, 15, -1, -128)))
    }

    @Test fun partialUpdatesProduceTheSameDigestAsOneShot() {
        val data = "abc".encodeToByteArray()
        val expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        assertEquals(expected, Hashing.sha256(data))
        val stream = Hashing.sha256Stream()
        stream.update(data, 0, 2)
        stream.update(data, 2, 1)
        assertEquals(expected, stream.hexDigest())
    }
}
