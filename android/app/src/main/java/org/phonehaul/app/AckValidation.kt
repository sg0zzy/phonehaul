package org.phonehaul.app

import java.io.IOException

object AckValidation {
    private val accepted = setOf("committed", "skipped", "already_present")

    fun validate(
        status: String,
        ackSize: Long,
        ackSha256: String,
        declaredSha256: String?,
        declaredSize: Long,
        actualHash: String,
    ): String {
        if (status !in accepted) throw IOException("Unexpected receiver acknowledgement")
        if (status == "skipped") return status
        if (
            ackSize != declaredSize ||
            ackSha256 != actualHash ||
            (declaredSha256 != null && declaredSha256 != actualHash)
        ) {
            throw IOException("Receiver acknowledgement mismatch")
        }
        return status
    }
}
