package org.phonehaul.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.IOException

class AckValidationTest {
    private val hash = "b".repeat(64)

    private fun ack(
        status: String,
        ackSize: Long = 10,
        ackSha256: String = hash,
        declaredSha256: String? = hash,
    ) = AckValidation.validate(status, ackSize, ackSha256, declaredSha256, 10, hash)

    @Test fun acceptedAcknowledgementsPassThrough() {
        for (status in listOf("committed", "skipped", "already_present")) {
            assertEquals(status, ack(status))
        }
    }

    @Test fun queueAndFailureStatusesAreRejected() {
        for (status in listOf("queued", "sending", "failed", "")) {
            assertThrows(IOException::class.java) { ack(status) }
        }
    }

    @Test fun skippedAcknowledgementIgnoresItsFields() {
        assertEquals("skipped", ack("skipped", ackSize = -1, ackSha256 = ""))
    }

    @Test fun sizeAndHashMismatchAreRejected() {
        assertThrows(IOException::class.java) { ack("committed", ackSize = 9) }
        assertThrows(IOException::class.java) { ack("committed", ackSha256 = "") }
        assertThrows(IOException::class.java) { ack("committed", declaredSha256 = "c".repeat(64)) }
    }

    @Test fun unverifiedItemOnlyChecksTheAcknowledgedHash() {
        assertEquals("committed", ack("committed", declaredSha256 = null))
    }
}
