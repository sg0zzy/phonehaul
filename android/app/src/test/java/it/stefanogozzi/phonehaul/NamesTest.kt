package it.stefanogozzi.phonehaul

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.IOException

class NamesTest {
    @Test fun separatorsAndControlCharactersBecomeUnderscores() {
        assertEquals("a_b_c_", Names.safeName("a/b\\c\u0001"))
        assertEquals("_", Names.safeName("\u0000"))
        assertEquals("spaced", Names.safeName("  spaced  "))
        assertEquals("ok.png", Names.safeName("ok.png"))
    }

    @Test fun emptyAndDotNamesFallBackToUnnamed() {
        assertEquals("unnamed", Names.safeName(""))
        assertEquals("unnamed", Names.safeName("."))
        assertEquals("unnamed", Names.safeName(".."))
    }

    @Test fun namesWithoutAnExtensionKeepTheWholeStem() {
        assertEquals("notes (1)", Names.uniqueName("notes") { it == "notes" })
        assertEquals(".gitignore (1)", Names.uniqueName(".gitignore") { it == ".gitignore" })
    }

    @Test fun conflictLimitStopsBeforeRenamingForever() {
        assertThrows(IOException::class.java) { Names.uniqueName("photo.jpg") { true } }
    }
}
