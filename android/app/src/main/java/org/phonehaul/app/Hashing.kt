package org.phonehaul.app

import java.security.MessageDigest

object Hashing {
    fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

    fun sha256(bytes: ByteArray): String = hex(MessageDigest.getInstance("SHA-256").digest(bytes))

    fun sha256Stream(): Sha256Stream = Sha256Stream()
}

class Sha256Stream {
    private val digest = MessageDigest.getInstance("SHA-256")

    fun update(
        b: ByteArray,
        offset: Int,
        len: Int,
    ) {
        digest.update(b, offset, len)
    }

    fun hexDigest(): String = Hashing.hex(digest.digest())
}
