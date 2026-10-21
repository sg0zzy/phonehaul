package org.phonehaul.app

import org.junit.Assert.assertThrows
import org.junit.Test
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate

class PinnedTrustManagerTest {
    private val certificate: X509Certificate =
        javaClass.getResourceAsStream("/pinned-cert.der")!!.use {
            CertificateFactory.getInstance("X.509").generateCertificate(it) as X509Certificate
        }

    @Test fun matchingCertificateIsTrusted() {
        val fingerprint =
            MessageDigest
                .getInstance("SHA-256")
                .digest(certificate.encoded)
                .joinToString("") { "%02x".format(it) }
        pinnedTrustManager(fingerprint).checkServerTrusted(arrayOf(certificate), "RSA")
    }

    @Test fun wrongCertificateAndEmptyChainAreRejected() {
        val manager = pinnedTrustManager("0".repeat(64))
        assertThrows(CertificateException::class.java) {
            manager.checkServerTrusted(arrayOf(certificate), "RSA")
        }
        assertThrows(CertificateException::class.java) {
            manager.checkServerTrusted(emptyArray(), "RSA")
        }
    }
}
