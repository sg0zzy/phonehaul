package org.phonehaul.app

import org.junit.Assert.*
import org.junit.Test

class PairingTest {
    private val token = "a".repeat(43)
    private val fingerprint = "b".repeat(64)

    private fun uri(host: String) = "phonehaul://pair?v=1&h=$host&p=57322&s=$token&f=$fingerprint"

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
}
