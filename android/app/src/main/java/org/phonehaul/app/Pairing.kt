package org.phonehaul.app

import java.net.URI
import java.net.URLDecoder

data class Pairing(
    val host: String,
    val port: Int,
    val token: String,
    val fingerprint: String,
) {
    val label: String get() = "$host:$port"
}

object PairingParser {
    fun parse(raw: String): Pairing {
        val uri =
            try {
                URI(raw.trim())
            } catch (_: Exception) {
                throw IllegalArgumentException("Invalid PhoneHaul QR")
            }
        require(
            uri.scheme == "phonehaul" && uri.host == "pair" && uri.path.isNullOrEmpty() && uri.fragment == null,
        ) { "Invalid PhoneHaul QR" }
        val fields =
            uri.rawQuery?.split('&')?.map {
                val parts = it.split('=', limit = 2)
                require(parts.size == 2) { "Invalid PhoneHaul QR" }
                URLDecoder.decode(parts[0], "UTF-8") to URLDecoder.decode(parts[1], "UTF-8")
            } ?: throw IllegalArgumentException("Invalid PhoneHaul QR")
        require(fields.size == 5 && fields.map { it.first }.toSet() == setOf("v", "h", "p", "s", "f")) { "Invalid PhoneHaul QR" }
        val values = fields.toMap()
        val host = values.getValue("h")
        val port = values.getValue("p").toIntOrNull()
        val token = values.getValue("s")
        val fingerprint = values.getValue("f")
        require(
            values["v"] == "1" &&
                isPrivateIpv4(host) &&
                port != null &&
                port in 1..65535 &&
                Regex("[A-Za-z0-9_-]{43}").matches(token) &&
                Regex("[a-f0-9]{64}").matches(fingerprint),
        ) { "Invalid or non-local PhoneHaul QR" }
        return Pairing(host, port, token, fingerprint)
    }

    fun isPrivateIpv4(host: String): Boolean {
        val parts = host.split('.')
        if (parts.size != 4 || parts.any { it.isEmpty() || it.length > 3 || it.any { c -> !c.isDigit() } }) return false
        val bytes = parts.map { it.toIntOrNull() ?: return false }
        if (bytes.any { it !in 0..255 }) return false
        return bytes[0] == 10 ||
            bytes[0] == 192 &&
            bytes[1] == 168 ||
            bytes[0] == 172 &&
            bytes[1] in 16..31 ||
            bytes[0] == 169 &&
            bytes[1] == 254
    }
}
