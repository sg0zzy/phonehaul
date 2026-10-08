package org.phonehaul.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingTest {
    private val token = "a".repeat(43)
    private val fingerprint = "b".repeat(64)

    private fun uri(host: String) = "phonehaul://pair?v=1&h=$host&p=57322&s=$token&f=$fingerprint"

    @Test fun pairingToStringRedactsToken() {
        val pairing = PairingParser.parse(uri("192.168.1.20"))
        assertFalse(pairing.toString().contains(token))
    }

    @Test fun acceptsPrivateLanAddress() {
        assertEquals("192.168.1.20", PairingParser.parse(uri("192.168.1.20")).host)
        assertTrue(PairingParser.isPrivateIpv4("172.31.0.1"))
        assertTrue(PairingParser.isPrivateIpv4("10.0.0.1"))
    }

    @Test fun rejectsPublicAndMalformedQr() {
        for (host in listOf("8.8.8.8", "127.0.0.1", "10.example.com", "192.168.1.999", "172.32.0.1")) {
            assertThrows(IllegalArgumentException::class.java) { PairingParser.parse(uri(host)) }
        }
        assertThrows(IllegalArgumentException::class.java) { PairingParser.parse("https://example.com") }
        assertThrows(IllegalArgumentException::class.java) { PairingParser.parse(uri("10.0.0.1") + "&s=another") }
    }

    @Test fun portMustBeInRange() {
        for (port in listOf("0", "65536", "notaport")) {
            assertThrows(IllegalArgumentException::class.java) { PairingParser.parse(uri("10.0.0.1").replace("p=57322", "p=$port")) }
        }
        assertEquals(65535, PairingParser.parse(uri("10.0.0.1").replace("p=57322", "p=65535")).port)
    }

    @Test fun tokenAndFingerprintShapesAreRequired() {
        assertThrows(IllegalArgumentException::class.java) { PairingParser.parse(uri("10.0.0.1").replace("v=1", "v=2")) }
        assertThrows(IllegalArgumentException::class.java) { PairingParser.parse(uri("10.0.0.1").replace(token, "a".repeat(42))) }
        assertThrows(IllegalArgumentException::class.java) { PairingParser.parse(uri("10.0.0.1").replace(token, "a".repeat(43) + "!")) }
        assertThrows(IllegalArgumentException::class.java) { PairingParser.parse(uri("10.0.0.1").replace(fingerprint, "b".repeat(63))) }
        assertThrows(IllegalArgumentException::class.java) { PairingParser.parse(uri("10.0.0.1").replace(fingerprint, "B".repeat(64))) }
        assertEquals("b".repeat(64), PairingParser.parse(uri("10.0.0.1").replace(fingerprint, "b".repeat(64))).fingerprint)
    }

    @Test fun linkLocalRangeAndOctetShapesAreChecked() {
        assertTrue(PairingParser.isPrivateIpv4("169.254.1.1"))
        assertTrue(PairingParser.isPrivateIpv4("010.0.0.1"))
        for (host in listOf("169.253.1.1", "10.0.0.", "10.0.0.1234", "10.0.0.1.2", "10.0.0.1 ", "fe80::1")) {
            assertFalse(PairingParser.isPrivateIpv4(host))
        }
    }
}
