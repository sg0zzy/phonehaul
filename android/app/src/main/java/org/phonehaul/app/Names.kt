package org.phonehaul.app

import java.io.IOException

object Names {
    fun safeName(name: String): String {
        val cleaned = name.map { if (it == '/' || it == '\\' || it.code < 32) '_' else it }.joinToString("").trim()
        return if (cleaned.isEmpty() || cleaned == "." || cleaned == "..") "unnamed" else cleaned
    }

    fun uniqueName(
        name: String,
        taken: (String) -> Boolean,
    ): String {
        if (!taken(name)) return name
        val dot = name.lastIndexOf('.')
        val stem = if (dot > 0) name.substring(0, dot) else name
        val suffix = if (dot > 0) name.substring(dot) else ""
        for (n in 1..99_999) {
            val candidate = "$stem ($n)$suffix"
            if (!taken(candidate)) return candidate
        }
        throw IOException("Too many filename conflicts")
    }
}
