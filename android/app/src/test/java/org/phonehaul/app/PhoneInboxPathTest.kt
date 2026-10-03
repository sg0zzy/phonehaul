package org.phonehaul.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class PhoneInboxPathTest {
    @Test fun allPathsUsePublicDownloadRoot() {
        assertEquals("Download/", PhoneInboxPath.directory("report.pdf"))
        assertEquals("Download/", PhoneInboxPath.directory("Project/docs/spec.pdf"))
        assertEquals("Download/", PhoneInboxPath.directory("Other/spec.pdf"))
        assertEquals("spec.pdf", PhoneInboxPath.name("Project/docs/spec.pdf"))
        assertEquals("spec.pdf", PhoneInboxPath.name("Other/spec.pdf"))
    }

    @Test fun rejectsUntrustedPaths() {
        for (path in listOf("../escape", "Project/../../escape", "/etc/passwd", "C:/absolute", "a//b", "a/./b", "a\\b", "a/\u0000b")) {
            assertThrows(IllegalArgumentException::class.java) { PhoneInboxPath.directory(path) }
        }
    }

    @Test fun duplicateNamesReceiveDeterministicSuffix() {
        assertEquals("report.pdf", PhoneInboxPath.renamed("report.pdf", 0))
        assertEquals("report (1).pdf", PhoneInboxPath.renamed("report.pdf", 1))
        assertEquals("report (2).pdf", PhoneInboxPath.renamed("report.pdf", 2))
        assertEquals("report (2).pdf", PhoneInboxPath.chooseName("report.pdf") { it in setOf("report.pdf", "report (1).pdf") })
        assertEquals("report.pdf", PhoneInboxPath.chooseName("report.pdf") { false })
        assertEquals(
            "spec (1).pdf",
            PhoneInboxPath.chooseName(PhoneInboxPath.name("Other/spec.pdf")) {
                it ==
                    PhoneInboxPath.name("Project/docs/spec.pdf")
            },
        )
    }

    @Test fun imageNamesHaveMediaMimeTypes() {
        assertEquals("image/jpeg", PhoneInboxPath.imageMimeType("photo.JPG"))
        assertEquals("image/jpeg", PhoneInboxPath.imageMimeType("photo (1).jpeg"))
        assertEquals("image/png", PhoneInboxPath.imageMimeType("screenshot.png"))
        assertEquals("image/webp", PhoneInboxPath.imageMimeType("image.webp"))
        assertEquals("image/heic", PhoneInboxPath.imageMimeType("camera.HEIC"))
        assertEquals(null, PhoneInboxPath.imageMimeType("archive.zip"))
    }
}
